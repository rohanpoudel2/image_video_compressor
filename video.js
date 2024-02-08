const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');

process.on('message', payload => {
  const {
    loadFolder,
    optimiseFolder
  } = payload;

  optimiseVideo(loadFolder, optimiseFolder);
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

const processVideo = (videoPath, optimiseFolder) => {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(optimiseFolder)) {
      fs.mkdirSync(optimiseFolder);
    }
    const optimisedPath = path.join(optimiseFolder, path.basename(videoPath));
    ffmpeg(videoPath)
      .fps(30)
      .addOptions(["-crf 32"])
      .on("end", () => {
        resolve();
      })
      .on("error", (err) => {
        reject(err);
      })
      .on("progress", (progress) => {
        console.log(`⌛️ Optimising video: ${progress.percent}% done \n`);
      })
      .save(optimisedPath);
  })
}

const optimiseVideo = (loadFolder, optimiseFolder) => {
  loadVideos(loadFolder)
    .then(videosPath => {
      if (videosPath) {
        return Promise.all(videosPath.map(videoPath => processVideo(videoPath, optimiseFolder)));
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

