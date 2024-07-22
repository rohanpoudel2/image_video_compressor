const fs = require("fs");
const path = require("path");

let processCount = 0;
global.totalFiles = 0;

const loadFiles = (loadFolder, filterFunction) => {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(loadFolder)) {
      fs.mkdirSync(loadFolder);
      reject(`Add files to this path: ${loadFolder}`);
    }
    fs.readdir(loadFolder, (err, files) => {
      if (err) {
        reject(err);
      } else {
        const filteredFiles = files
          .map((fileName) => path.join(loadFolder, fileName))
          .filter(filterFunction);
        resolve(filteredFiles);
      }
    });
  });
};

const createOptimiseFolder = (optimiseFolder) => {
  if (!fs.existsSync(optimiseFolder)) {
    fs.mkdirSync(optimiseFolder);
  }
};

const logProgress = (progress = null) => {
  processCount++;
  const percentDone = progress
    ? progress
    : Math.floor((processCount / global.totalFiles) * 100);
  process.stdout.write(`\r⌛️ Optimising: ${percentDone.toFixed(2)}% \n`);
};

const processExtension = (ext) => (ext.includes(".") ? ext : `.${ext}`);

module.exports = {
  loadFiles,
  createOptimiseFolder,
  logProgress,
  processExtension,
};
