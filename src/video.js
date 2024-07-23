const path = require("path");
const ffmpeg = require("fluent-ffmpeg");
const {
  loadFiles,
  createOptimiseFolder,
  logProgress,
  lastOrOnlyOne,
} = require("../utils/fns");

const EXTENSION = require(path.join(__dirname, "../formats.json")).VideoFormats;

process.on("message", (payload) => {
  const { loadFolder, optimiseFolder, quality, output } = payload;
  optimiseVideo(loadFolder, optimiseFolder, quality, output);
});

const isVideo = (fileName) =>
  EXTENSION.includes(path.extname(fileName).toLowerCase());

const processVideo = (
  videoPath,
  optimiseFolder,
  quality,
  output,
  completed
) => {
  return new Promise((resolve, reject) => {
    createOptimiseFolder(optimiseFolder);
    const optimisedPath = path.join(
      optimiseFolder,
      path.basename(videoPath, path.extname(videoPath)) + output
    );
    const adjustedQuality = 100 - quality;

    ffmpeg(videoPath)
      .fps(30)
      .videoCodec("libx264")
      .outputOptions([`-crf ${adjustedQuality}`, "-preset fast"])
      .on("end", () => {
        logProgress(null, "Video", optimisedPath, completed);
        resolve();
      })
      .on("error", (err) => {
        console.error(`Error processing video ${videoPath}: ${err}`);
        reject(err);
      })
      .on("progress", (progress) => {
        const percentage = progress.percent ? progress.percent : 0;
        logProgress(percentage, "Video", optimisedPath, false);
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
          videosPath.map((videoPath, i) =>
            processVideo(
              videoPath,
              optimiseFolder,
              quality,
              output,
              lastOrOnlyOne(videosPath, i)
            )
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
