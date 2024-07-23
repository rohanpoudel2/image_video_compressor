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

const cleanLogsPrint = (msg) => {
  process.stdout.clearLine();
  process.stdout.cursorTo(0);
  process.stdout.write(msg);
};

const logProgress = (
  progress = null,
  type = "",
  optimiseFolder = "",
  completed = false
) => {
  processCount++;
  const percentDone = parseInt(
    progress || type === "Video"
      ? progress
      : Math.floor((processCount / global.totalFiles) * 100)
  );
  cleanLogsPrint(`⌛️ Optimising: ${percentDone}%`);
  if (completed && percentDone == 100) {
    cleanLogsPrint(
      `\n ${type} optimised and saved at: ${optimiseFolder.split("/").slice(0, -1).join("/")}`
    );
  }
};

const lastOrOnlyOne = (arr, i) => i === arr.length - 1 || arr.length === 1;

const processExtension = (ext) => (ext.includes(".") ? ext : `.${ext}`);

module.exports = {
  loadFiles,
  createOptimiseFolder,
  logProgress,
  lastOrOnlyOne,
  processExtension,
  cleanLogsPrint,
};
