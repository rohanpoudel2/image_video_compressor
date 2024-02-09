const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');

process.on('message', payload => {
  const {
    loadFolder,
    optimiseFolder,
    videoConfig
  } = payload;

  optimiseVideo(loadFolder, optimiseFolder, videoConfig);
});

const EXTENSION = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];

const isVideo = fileName => EXTENSION.includes(path.extname(fileName).toLowerCase());

const loadVideos = (loadFolder) => {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(loadFolder)) {
      fs.mkdirSync(loadFolder);
      reject(`Add videos to this path: ${loadFolder}`);
    }
    fs.readdir(loadFolder, (err, files) => {
      if (err) {
        reject(err);
      } else {
        const videosPath = files
          .map((fileName) => path.join(loadFolder, fileName))
          .filter(isVideo);
        resolve(videosPath);
      }
    });
  });
};

const processVideo = (videoPath, optimiseFolder, videoConfig) => {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(optimiseFolder)) {
      fs.mkdirSync(optimiseFolder);
    }
    const optimisedPath = path.join(optimiseFolder, path.basename(videoPath));
    ffmpeg(videoPath)
      .fps(videoConfig.fps)
      .addOptions([`-crf ${videoConfig.quality}`])
      .on("end", () => {
        resolve();
      })
      .on("error", (err) => {
        reject(err);
      })
      .on("progress", (progress) => {
        console.log(`⌛️ Optimising video: ${Math.floor(progress.percent)}% done \n`);
      })
      .save(optimisedPath);
  })
}

const optimiseVideo = (loadFolder, optimiseFolder, videoConfig) => {
  loadVideos(loadFolder)
    .then(videosPath => {
      if (videosPath) {
        return Promise.all(videosPath.map(videoPath => processVideo(videoPath, optimiseFolder, videoConfig)));
      }
    })
    .then(() => {
      process.send({ text: 'Video optimisation completed 😄' });
      process.exit();
    })
    .catch(err => {
      console.error(err);
      process.send({ text: 'Video optimisation error 😵‍💫' });
      process.exit();
    })
}

