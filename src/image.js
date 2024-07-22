const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const {
  loadFiles,
  createOptimiseFolder,
  logProgress,
} = require("../utils/fns");

const Formats = require(path.join(__dirname, "../formats.json")).ImageFormats;

process.on("message", (payload) => {
  const { loadFolder, optimiseFolder, quality, output } = payload;
  optimiseImages(loadFolder, optimiseFolder, quality, output);
});

const isImage = (fileName) =>
  Object.keys(Formats).includes(path.extname(fileName).toLowerCase());

const processImage = (imagePath, optimiseFolder, quality, output) => {
  return new Promise((resolve, reject) => {
    createOptimiseFolder(optimiseFolder);

    const optimisedPath = path.join(
      optimiseFolder,
      path.basename(imagePath, path.extname(imagePath)) + output
    );
    let image = sharp(imagePath);

    const formatMethod = Formats[output];
    if (!formatMethod) {
      return reject(new Error(`Unsupported output format: ${output}`));
    }

    image = image[formatMethod]({ quality });

    image.toFile(optimisedPath, (err) => {
      if (err) {
        console.error(`Error processing image ${imagePath}: ${err}`);
        reject(err);
      } else {
        console.log(`Image optimised and saved at: ${optimisedPath}`);
        logProgress();
        resolve();
      }
    });
  });
};

const optimiseImages = (loadFolder, optimiseFolder, quality, output) => {
  loadFiles(loadFolder, isImage)
    .then((imagesPath) => {
      if (imagesPath) {
        global.totalFiles = imagesPath.length;
        return Promise.all(
          imagesPath.map((imagePath) =>
            processImage(imagePath, optimiseFolder, quality, output)
          )
        );
      }
    })
    .then(() => {
      process.send({ text: "Image optimisation completed 😄" });
      process.exit();
    })
    .catch((err) => {
      console.error(err);
      process.send({ text: "Image optimisation error 😵‍💫" });
      process.exit();
    });
};
