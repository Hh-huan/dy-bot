"""Seed-VC 实时变声引擎：麦克风块进、变声块出。

流式缓冲与 SOLA 拼接逻辑参考 Seed-VC 的 real-time-gui.py，
但去掉 GUI / funasr 依赖，改用 RMS 门限做静音跳过。
"""

from __future__ import annotations

import math
import os
import time
from contextlib import nullcontext
from types import SimpleNamespace

os.environ.setdefault('HF_ENDPOINT', 'https://hf-mirror.com')
os.environ.setdefault('HF_HUB_DISABLE_TELEMETRY', '1')

import librosa
import numpy as np
import torch
import torch.nn.functional as F
import torchaudio
from seed_vc.inference_realtime import load_models

# Ada 显卡上 TF32/benchmark 能省下相当一部分推理耗时；默认关闭会导致实测翻倍
torch.backends.cuda.matmul.allow_tf32 = True
torch.backends.cudnn.allow_tf32 = True
torch.backends.cudnn.benchmark = True


def _resample(wave: torch.Tensor, src: int, dst: int) -> torch.Tensor:
    if src == dst:
        return wave
    return torchaudio.functional.resample(wave, src, dst)


class StreamingVoiceChanger:
    def __init__(
        self,
        reference_path: str,
        sample_rate: int = 48000,
        block_time: float = 0.25,
        crossfade_time: float = 0.04,
        extra_time_ce: float = 2.5,
        extra_time: float = 0.5,
        extra_time_right: float = 0.04,
        diffusion_steps: int = 8,
        inference_cfg_rate: float = 0.7,
        max_prompt_length: float = 3.0,
        prompt_offset: float = 0.0,
        fp16: bool = True,
        vad_threshold: float = -48.0,
        vad_hold_ms: int = 300,
        soft_eq: bool = True,
    ):
        self.reference_path = os.path.abspath(reference_path)
        if not os.path.exists(self.reference_path):
            raise FileNotFoundError(f'参考音频不存在：{self.reference_path}')

        self.sample_rate = int(sample_rate)
        self.block_time = float(block_time)
        self.crossfade_time = float(crossfade_time)
        self.extra_time_ce = float(extra_time_ce)
        self.extra_time = float(extra_time)
        self.extra_time_right = float(extra_time_right)
        self.diffusion_steps = int(diffusion_steps)
        self.inference_cfg_rate = float(inference_cfg_rate)
        self.max_prompt_length = float(max_prompt_length)
        self.prompt_offset = max(0.0, float(prompt_offset))
        self.vad_threshold = float(vad_threshold)
        self.vad_hold_ms = int(vad_hold_ms)

        self.device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
        self.fp16 = bool(fp16 and self.device.type == 'cuda')

        model_args = SimpleNamespace(checkpoint=None, config_path=None, fp16=self.fp16)
        self.model_set = load_models(model_args)
        (self.model, self.semantic_fn, self.f0_fn, self.vocoder_fn,
         self.campplus_model, self.to_mel, mel_fn_args) = self.model_set
        self.model_sr = int(mel_fn_args['sampling_rate'])
        self.hop_length = int(mel_fn_args['hop_size'])

        reference, _ = librosa.load(self.reference_path, sr=self.model_sr)
        self.reference_wav = torch.from_numpy(reference).float().to(self.device)
        self._prepare_prompt()

        self.zc = self.sample_rate // 50
        self.block_frame = int(round(self.block_time * self.sample_rate / self.zc)) * self.zc
        self.block_frame_16k = 320 * self.block_frame // self.zc
        self.crossfade_frame = int(round(self.crossfade_time * self.sample_rate / self.zc)) * self.zc
        self.sola_buffer_frame = min(self.crossfade_frame, 4 * self.zc)
        self.sola_search_frame = self.zc
        self.extra_frame = int(round(self.extra_time_ce * self.sample_rate / self.zc)) * self.zc
        self.extra_frame_right = int(round(self.extra_time_right * self.sample_rate / self.zc)) * self.zc

        self.input_wav = torch.zeros(
            self.extra_frame + self.crossfade_frame + self.sola_search_frame
            + self.block_frame + self.extra_frame_right,
            device=self.device, dtype=torch.float32,
        )
        self.input_wav_res = torch.zeros(
            320 * self.input_wav.shape[0] // self.zc,
            device=self.device, dtype=torch.float32,
        )
        self.sola_buffer = torch.zeros(
            self.sola_buffer_frame, device=self.device, dtype=torch.float32,
        )
        self.skip_head = self.extra_frame // self.zc
        self.skip_tail = self.extra_frame_right // self.zc
        self.return_length = (
            self.block_frame + self.sola_buffer_frame + self.sola_search_frame
        ) // self.zc
        self.ce_dit_difference = self.extra_time_ce - self.extra_time

        self.fade_in_window = (
            torch.sin(
                0.5 * math.pi * torch.linspace(
                    0.0, 1.0, steps=self.sola_buffer_frame,
                    device=self.device, dtype=torch.float32,
                )
            ) ** 2
        )
        self.fade_out_window = 1 - self.fade_in_window
        self.resampler2 = None
        if self.model_sr != self.sample_rate:
            self.resampler2 = torchaudio.transforms.Resample(
                orig_freq=self.model_sr, new_freq=self.sample_rate, dtype=torch.float32,
            ).to(self.device)

        self._vad_hold_until = 0.0
        self._last_infer_ms = 0.0
        self._last_total_ms = 0.0
        self._last_rms_db = -120.0
        self._gated = True
        self._chunks = 0
        self._warmed = False

        # 音色柔化：Seed-VC 输出会削掉低频、抬高中高频，听感偏尖。
        # 补回低频 + 压一点 1~2kHz + 轻切 9kHz 以上，接近「糯」的听感。
        self.soft_eq = bool(soft_eq)
        if self.soft_eq:
            from scipy.signal import butter
            nyq = self.sample_rate / 2.0
            self._sos_low = butter(2, 250 / nyq, 'low', output='sos')
            self._sos_band = butter(2, [900 / nyq, 2100 / nyq], 'band', output='sos')
            self._sos_air = butter(2, 9000 / nyq, 'low', output='sos')
            self._zi_low = np.zeros((self._sos_low.shape[0], 2))
            self._zi_band = np.zeros((self._sos_band.shape[0], 2))
            self._zi_air = np.zeros((self._sos_air.shape[0], 2))

    def _prepare_prompt(self) -> None:
        # prompt_offset 用来跳过参考音频开头最尖的片段，取更柔和的段落做音色参考
        start = int(self.model_sr * self.prompt_offset)
        ref = self.reference_wav[start: start + int(self.model_sr * self.max_prompt_length)]
        if ref.numel() < int(self.model_sr * 0.5):
            ref = self.reference_wav[: int(self.model_sr * self.max_prompt_length)]
        ref_16k = _resample(ref, self.model_sr, 16000)
        with torch.inference_mode():
            self.prompt_condition = None
            features = self.semantic_fn(ref_16k.unsqueeze(0))
            fbank = torchaudio.compliance.kaldi.fbank(
                ref_16k.unsqueeze(0), num_mel_bins=80, dither=0, sample_frequency=16000,
            )
            fbank = fbank - fbank.mean(dim=0, keepdim=True)
            self.style2 = self.campplus_model(fbank.unsqueeze(0))
            self.mel2 = self.to_mel(ref.unsqueeze(0))
            target_lengths = torch.LongTensor([self.mel2.size(2)]).to(self.mel2.device)
            self.prompt_condition = self.model.length_regulator(
                features, ylens=target_lengths, n_quantizers=3, f0=None,
            )[0]

    @torch.inference_mode()
    def _infer(self, input_wav_res: torch.Tensor) -> torch.Tensor:
        frame_difference = int(self.ce_dit_difference * 50)
        features = self.semantic_fn(input_wav_res.unsqueeze(0))
        features = features[:, frame_difference:]
        target_lengths = torch.LongTensor(
            [(self.skip_head + self.return_length + self.skip_tail - frame_difference)
             / 50 * self.model_sr // self.hop_length]
        ).to(features.device)
        condition = self.model.length_regulator(
            features, ylens=target_lengths, n_quantizers=3, f0=None,
        )[0]
        cat_condition = torch.cat([self.prompt_condition, condition], dim=1)
        autocast = (
            torch.autocast(device_type='cuda', dtype=torch.float16)
            if self.fp16 else nullcontext()
        )
        with autocast:
            converted = self.model.cfm.inference(
                cat_condition,
                torch.LongTensor([cat_condition.size(1)]).to(self.mel2.device),
                self.mel2,
                self.style2,
                None,
                n_timesteps=self.diffusion_steps,
                inference_cfg_rate=self.inference_cfg_rate,
            )
            converted = converted[:, :, self.mel2.size(-1):]
            wave = self.vocoder_fn(converted).squeeze()
        output_len = self.return_length * self.model_sr // 50
        tail_len = self.skip_tail * self.model_sr // 50
        return wave[-output_len - tail_len: -tail_len]

    def _push_input(self, block: np.ndarray) -> None:
        indata = torch.from_numpy(np.ascontiguousarray(block, dtype=np.float32)).to(self.device)
        self.input_wav[:-self.block_frame] = self.input_wav[self.block_frame:].clone()
        self.input_wav[-indata.shape[0]:] = indata

        self.input_wav_res[:-self.block_frame_16k] = self.input_wav_res[self.block_frame_16k:].clone()
        segment = self.input_wav[-indata.shape[0] - 2 * self.zc:]
        resampled = _resample(segment, self.sample_rate, 16000)[320:]
        target = 320 * (indata.shape[0] // self.zc + 1)
        if resampled.numel() != target:
            if resampled.numel() > target:
                resampled = resampled[-target:]
            else:
                resampled = F.pad(resampled, (target - resampled.numel(), 0))
        self.input_wav_res[-target:] = resampled

    def process_block(self, block: np.ndarray, force: bool = False) -> np.ndarray:
        started = time.perf_counter()
        if block.shape[0] != self.block_frame:
            fixed = np.zeros(self.block_frame, dtype=np.float32)
            fixed[: min(block.shape[0], self.block_frame)] = block[: self.block_frame]
            block = fixed

        rms = float(np.sqrt(np.mean(np.square(block)) + 1e-12))
        self._last_rms_db = 20.0 * math.log10(rms + 1e-12)
        now = time.monotonic()
        if self._last_rms_db > self.vad_threshold:
            self._vad_hold_until = now + self.vad_hold_ms / 1000.0
        active = force or now <= self._vad_hold_until
        self._gated = not active

        self._push_input(block)

        if not active:
            self.sola_buffer.zero_()
            self._chunks += 1
            self._last_total_ms = (time.perf_counter() - started) * 1000
            return np.zeros(self.block_frame, dtype=np.float32)

        if self.device.type == 'cuda':
            torch.cuda.synchronize()
        infer_started = time.perf_counter()
        converted = self._infer(self.input_wav_res)
        if self.resampler2 is not None:
            converted = self.resampler2(converted)
        if self.device.type == 'cuda':
            torch.cuda.synchronize()
        self._last_infer_ms = (time.perf_counter() - infer_started) * 1000

        conv_input = converted[None, None, : self.sola_buffer_frame + self.sola_search_frame]
        corr_num = F.conv1d(conv_input, self.sola_buffer[None, None, :])
        corr_den = torch.sqrt(
            F.conv1d(
                conv_input ** 2,
                torch.ones(1, 1, self.sola_buffer_frame, device=self.device),
            ) + 1e-8
        )
        corr = corr_num[0, 0] / corr_den[0, 0]
        offset = int(torch.argmax(corr).item()) if corr.numel() > 1 else int(corr.item())

        converted = converted[offset:]
        converted[: self.sola_buffer_frame] *= self.fade_in_window
        converted[: self.sola_buffer_frame] += self.sola_buffer * self.fade_out_window
        self.sola_buffer[:] = converted[
            self.block_frame : self.block_frame + self.sola_buffer_frame
        ]

        output = converted[: self.block_frame].float().cpu().numpy()
        if self.soft_eq:
            output = self._apply_eq(output)
        self._chunks += 1
        self._last_total_ms = (time.perf_counter() - started) * 1000
        return output

    def _apply_eq(self, out: np.ndarray) -> np.ndarray:
        from scipy.signal import sosfilt
        low, self._zi_low = sosfilt(self._sos_low, out, zi=self._zi_low)
        band, self._zi_band = sosfilt(self._sos_band, out, zi=self._zi_band)
        soft, self._zi_air = sosfilt(
            self._sos_air, out + 0.9 * low - 0.3 * band, zi=self._zi_air,
        )
        return np.clip(soft * 0.9, -1.0, 1.0)

    def warmup(self) -> None:
        if self._warmed:
            return
        dummy = np.zeros(self.block_frame, dtype=np.float32)
        self.process_block(dummy, force=True)
        self.reset()
        self._warmed = True

    def reset(self) -> None:
        self.input_wav.zero_()
        self.input_wav_res.zero_()
        self.sola_buffer.zero_()
        self._vad_hold_until = 0.0
        self._gated = True
        self._chunks = 0
        if self.soft_eq:
            self._zi_low[:] = 0
            self._zi_band[:] = 0
            self._zi_air[:] = 0

    @property
    def gated(self) -> bool:
        """最近一块是否被 VAD 判定为静音（此时输出为全零，无需排队）。"""
        return self._gated

    def stats(self) -> dict:
        block_ms = self.block_frame * 1000.0 / self.sample_rate
        return {
            'inferMs': round(self._last_infer_ms, 1),
            'totalMs': round(self._last_total_ms, 1),
            'latencyMs': round(block_ms + self.extra_time_right * 1000.0
                               + self._last_infer_ms),
            'rmsDb': round(self._last_rms_db, 1),
            'gated': self._gated,
            'chunks': self._chunks,
            'sampleRate': self.sample_rate,
            'modelSampleRate': self.model_sr,
            'blockFrame': self.block_frame,
            'diffusionSteps': self.diffusion_steps,
            'fp16': self.fp16,
            'device': str(self.device),
        }
