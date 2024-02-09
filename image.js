const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

process.on('message', payload => {
  const {
    loadFolder,
    optimiseFolder,
    imageConfig
  } = payload;

  optimiseImages(loadFolder, optimiseFolder, imageConfig);
});

const EXTENSION = ['.jpg', '.jpeg', '.png'];

const isImage = fileName => EXTENSION.includes(path.extname(fileName).toLowerCase());

let processCount = 0;
let totalImage = 0;

const progressLog = () => {
  processCount++;
  const process = Math.floor(processCount / totalImage * 100);
  console.log(`⌛️ Optimising Image: ${process}% done \n`);
}

const loadImages = (loadFolder) => {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(loadFolder)) {
      fs.mkdirSync(loadFolder);
      reject(`Add images to this path: ${loadFolder}`);
    }
    fs.readdir(loadFolder, (err, files) => {
      if (err) {
        reject(err);
      } else {
        const imagesPath = files
          .map((fileName) => path.join(loadFolder, fileName))
          .filter(isImage);
        totalImage = imagesPath.length;
        resolve(imagesPath);
      }
    });
  });
};

const processImage = (imagePath, optimiseFolder, imageConfig) => {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(optimiseFolder)) {
      fs.mkdirSync(optimiseFolder);
    }
    let image = sharp(imagePath).webp({ quality: imageConfig.quality });
    const optimisedPath = path.join(optimiseFolder, path.basename(imagePath, path.extname(imagePath)) + `${imageConfig.output}`);

    image.toFile(optimisedPath, (err) => {
      if (err) {
        console.error(`Error processing image ${imagePath}: ${err}`);
        reject(err);
      } else {
        console.log(`Image optimised and saved at: ${optimisedPath} \n`);
        progressLog();
        resolve();
      }
    });
  });
};

const optimiseImages = (loadFolder, optimiseFolder, imageConfig) => {
  loadImages(loadFolder)
    .then(imagesPath => {
      if (imagesPath) {
        return Promise.all(imagesPath.map(imagePath => processImage(imagePath, optimiseFolder, imageConfig)));
      }
    })
    .then(() => {
      process.send({ text: 'Image optimisation completed 😄 \n' });
      process.exit();
    })
    .catch(err => {
      console.error(err);
      process.send({ text: 'Image optimisation error 😵‍💫 \n' });
      process.exit();
    });
};