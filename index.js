const path = require('path');
const { fork } = require('child_process');

const startImageProcess = () => {
  const loadFolder = path.join(__dirname, 'images');
  const optimiseFolder = path.join(__dirname, 'optimised_images');

  const imageProcess = fork('image.js');
  imageProcess.send({ loadFolder, optimiseFolder });
  imageProcess.on('message', message => {
    const { text } = message;
    console.log(text);
  });
}

const startVideoProcess = () => {
  const loadFolder = path.join(__dirname, 'videos');
  const optimiseFolder = path.join(__dirname, 'optimised_videos');

  const videoProcess = fork('video.js');
  videoProcess.send({ loadFolder, optimiseFolder });
  videoProcess.on('message', message => {
    const { text } = message;
    console.log(text);
  })
}

startImageProcess();
startVideoProcess();