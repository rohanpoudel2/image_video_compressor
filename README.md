# image-and-video-compressor

Compress Image and Video using Node.js

## Overview

`image-and-video-compressor` is a Node.js package that enables easy compression of images and videos within a specified folder. It utilizes the powerful `sharp` library for image compression and `fluent-ffmpeg` for video compression.

## Installation

```bash
npm install -g image-and-video-compressor
```
# Usage
## Image Compression

```bash
imgvidcompress optimise:image 'path_to_image_folder' --quality 'compression_quality'
```
### Example:

```bash
imgvidcompress optimise:image '/path/to/images' --quality 40
```
## Video Compression

```bash
imgvidcompress optimise:video 'path_to_video_folder' --quality 'compression_quality'
```
### Example:

```bash
imgvidcompress optimise:video '/path/to/videos' --quality 30
```
# Options

- `'path_to_image_folder'`: Path to the folder containing images.
- `'path_to_video_folder'`: Path to the folder containing videos.
- `'compression_quality'`: Quality parameter for compression (between 10 and 100).

# Credits
This package wouldn't be possible without the following awesome libraries:

-	[`sharp`](https://sharp.pixelplumbing.com/) - High-performance Node.js image processing.
-	[`fluent-ffmpeg`](https://www.npmjs.com/package/fluent-ffmpeg) - A fluent API to FFMPEG.

# License
This project is licensed under the MIT License - see the [LICENSE](./LICENSE) file for details.


### GitHub Repo Link
https://github.com/rohanpoudel2/image_video_compressor

### NPMJS Link
https://www.npmjs.com/package/image-and-video-compressor

### Created by
https://github.com/rohanpoudel2
