`green.h264` is a single synthetic green frame, generated for the browser's real WebCodecs decoder. It contains no device content or third-party artwork.

`ocr-bilingual.png` is synthetic typeset text on a white 1000×600 canvas: 设置 / 继续 / 搜索 and Settings / Continue / Search. It verifies bilingual recognition and word-level coordinate mapping independently of CI fonts. The identical `assets/ocr/self-test.png` is shipped for offline installation checks; neither contains phone content.

```sh
ffmpeg -f lavfi -i color=c=green:s=360x720:r=30 -frames:v 1 -c:v libx264 -profile:v baseline -tune zerolatency -f h264 green.h264
```

`green-fragmented.mp4` and `green-landscape.mp4` are synthetic green H.264 videos
(3 frames at 60 Hz, 360×720 and 720×360) in fragmented MP4. They exercise
real AVC parameter sets, key/P frames, fragment timestamps and concatenated
initialization segments after rotation, without device captures. Generated with
FFmpeg lavfi color, libx264 ultrafast/zerolatency, `-g 2 -bf 0` and
`-movflags frag_every_frame+empty_moov+default_base_moof`.

`green-videotoolbox.mp4` is a synthetic 360×720 green clip (3 frames) encoded
with macOS VideoToolbox, `-realtime 1 -bf 0 -g 60 -b:v 1M` and the same MP4
flags. Its SPS lacks explicit display-reorder bounds. The browser regression
decodes just its first frame after VUI normalization, without future frames or
`flush()`, and verifies the green pixels. No phone content is included.
