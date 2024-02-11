const path = require('path');
const { fork } = require('child_process');

module.exports = {
  startImageProcess: (loadFolder, quality) => {
    const optimiseFolder = path.join(loadFolder, 'optimised_images');

    const imageProcess = fork(path.join(__dirname, 'image.js'));
    imageProcess.send({ loadFolder, optimiseFolder, quality });
    imageProcess.on('message', message => {
      const { text } = message;
      console.log(text);
    });
  },
  startVideoProcess: (loadFolder, quality) => {
    const optimiseFolder = path.join(loadFolder, 'optimised_videos');

    const videoProcess = fork(path.join(__dirname, 'video.js'));
    videoProcess.send({ loadFolder, optimiseFolder, quality });
    videoProcess.on('message', message => {
      const { text } = message;
      console.log(text);
    })
  }
}