const path = require("path");
const { fork } = require("child_process");
const { cleanLogsPrint } = require("../utils/fns");

module.exports = {
  startImageProcess: (loadFolder, quality, output) => {
    const optimiseFolder = path.join(loadFolder, "optimised_images");

    const imageProcess = fork(path.join(__dirname, "image.js"));
    imageProcess.send({ loadFolder, optimiseFolder, quality, output });

    imageProcess.on("message", (message) =>
      cleanLogsPrint(`\n ${message.text}`)
    );
  },
  startVideoProcess: (loadFolder, quality, output) => {
    const optimiseFolder = path.join(loadFolder, "optimised_videos");

    const videoProcess = fork(path.join(__dirname, "video.js"));
    videoProcess.send({ loadFolder, optimiseFolder, quality, output });

    videoProcess.on("message", (message) =>
      cleanLogsPrint(`\n ${message.text}`)
    );
  },
};
