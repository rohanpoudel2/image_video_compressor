const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');

const EXTENSION = require(path.join(__dirname, '../formats.json')).VideoFormats;

process.on('message', payload => {
  const {
    loadFolder,
    optimiseFolder,
    quality,
    output
  } = payload;

  optimiseVideo(loadFolder, optimiseFolder, quality, output);
});

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

const processVideo = (videoPath, optimiseFolder, quality, output) => {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(optimiseFolder)) {
      fs.mkdirSync(optimiseFolder);
    }
    const optimisedPath = path.join(optimiseFolder, path.basename(videoPath, path.extname(videoPath)) + output);
    const adjustedQuality = 100 - quality;
    ffmpeg(videoPath)
      .fps(30)
      .addOptions([`-crf ${adjustedQuality}`])
      .keepDAR()
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

const optimiseVideo = (loadFolder, optimiseFolder, quality, output) => {
  loadVideos(loadFolder)
    .then(videosPath => {
      if (videosPath) {
        return Promise.all(videosPath.map(videoPath => processVideo(videoPath, optimiseFolder, quality, output)));
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

