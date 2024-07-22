const path = require("path");
const ffmpeg = require("fluent-ffmpeg");
const {
  loadFiles,
  createOptimiseFolder,
  logProgress,
} = require("../utils/fns");

const EXTENSION = require(path.join(__dirname, "../formats.json")).VideoFormats;

process.on("message", (payload) => {
  const { loadFolder, optimiseFolder, quality, output } = payload;
  optimiseVideo(loadFolder, optimiseFolder, quality, output);
});

const isVideo = (fileName) =>
  EXTENSION.includes(path.extname(fileName).toLowerCase());

const processVideo = (videoPath, optimiseFolder, quality, output) => {
  return new Promise((resolve, reject) => {
    createOptimiseFolder(optimiseFolder);
    const optimisedPath = path.join(
      optimiseFolder,
      path.basename(videoPath, path.extname(videoPath)) + output
    );
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
        logProgress(progress.percent, "Video");
      })
      .save(optimisedPath);
  });
};

const optimiseVideo = (loadFolder, optimiseFolder, quality, output) => {
  loadFiles(loadFolder, isVideo)
    .then((videosPath) => {
      if (videosPath) {
        global.totalFiles = videosPath.length;
        return Promise.all(
          videosPath.map((videoPath) =>
            processVideo(videoPath, optimiseFolder, quality, output)
          )
        );
      }
    })
    .then(() => {
      process.send({ text: "Video optimisation completed 😄" });
      process.exit();
    })
    .catch((err) => {
      console.error(err);
      process.send({ text: "Video optimisation error 😵‍💫" });
      process.exit();
    });
};
