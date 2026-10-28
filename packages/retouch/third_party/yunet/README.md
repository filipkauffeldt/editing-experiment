# YuNet face detector

`face_detection_yunet_2026may.onnx` is the dynamic-input YuNet model from the
[OpenCV Zoo](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet),
licensed under the MIT licence in [LICENSE](./LICENSE).

The model itself is not committed. Fetch it with `pnpm fetch-retouch`.

- Source: `https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_detection_yunet/face_detection_yunet_2026may.onnx`
- SHA-256: `ebafce4e3c118d6554634be5c27ab333b4c047a9a8c3faf1d7cf93101c22f0f0`
- Input: `1 × 3 × H × W` float32, BGR, 0..255, H/W multiples of 32
- Outputs: `cls_{8,16,32}`, `obj_{8,16,32}`, `bbox_{8,16,32}`, `kps_{8,16,32}`
