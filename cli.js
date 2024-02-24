#!/usr/bin/env node
const path = require("path");

const { startImageProcess, startVideoProcess } = require(
  path.join(__dirname, "src"),
);
const Formats = require(path.join(__dirname, "formats.json"));
const { processExtension } = require(path.join(__dirname, "utils/fns.js"));

const argv = require("yargs")
  .command("optimise:image", "Optimise images", {
    loadFolder: {
      describe: "Path to the Image folder",
      demandOption: true,
      type: "string",
    },
    quality: {
      describe: "Quality parameter (between   10 and   100)",
      default: 20,
      type: "number",
      coerce: (quality) => {
        if (quality < 10) {
          throw new Error("Quality cannot be less than   10.");
        }
        if (quality > 100) {
          throw new Error("Quality cannot be more than   100.");
        }
        return quality;
      },
    },
    output: {
      describe: "Image output format",
      type: "string",
      default: ".webp",
      coerce: (output) => {
        if (!Formats.ImageFormats.includes(output)) {
          throw new Error(
            `Supported formats: \n Images: ${Formats.ImageFormats.filter((format) => format.slice(0, 1) == ".").join(", ")}`,
          );
        }
        return output.trim();
      },
    },
  })
  .command("optimise:video", "Optimise videos", {
    loadFolder: {
      describe: "Path to the Video folder",
      demandOption: true,
      type: "string",
    },
    quality: {
      describe: "Quality parameter (between   10 and   100)",
      default: 20,
      type: "number",
      coerce: (quality) => {
        if (quality < 10) {
          throw new Error("Quality cannot be less than   10.");
        }
        if (quality > 100) {
          throw new Error("Quality cannot be more than   100.");
        }
        return quality;
      },
    },
    output: {
      describe: "Video output format",
      type: "string",
      default: ".mp4",
      coerce: (output) => {
        if (!Formats.VideoFormats.includes(output)) {
          throw new Error(
            `Supported formats: \n Videos: ${Formats.VideoFormats.filter((format) => format.slice(0, 1) == ".").join(", ")} `,
          );
        }
        return output.trim();
      },
    },
  })
  .scriptName("imgvidcompress")
  .usage("Usage: imgvidcompress <command> [options]")
  .example(
    'imgvidcompress optimise:image --loadFolder="/path/to/images" --quality=80 --output=".webp"',
  )
  .example(
    'imgvidcompress optimise:video --loadFolder="/path/to/videos" --quality=50 --output=".mp4"',
  )
  .epilogue("For more information, visit: https://www.rohanpoudel.com.np")
  .help().argv;

(() => {
  const { _ } = argv;
  const command = _[0];

  const loadFolder = argv.loadFolder.replace(/["']/g, "");
  const quality = parseInt(argv.quality.toString().replace(/["']/g, ""));
  const output = processExtension(argv.output);

  switch (command) {
    case "optimise:image": {
      startImageProcess(loadFolder, quality, output);
      break;
    }
    case "optimise:video": {
      startVideoProcess(loadFolder, quality, output);
      break;
    }
    default: {
      console.error(
        'Invalid command. Use "optimise:image" or "optimise:video"',
      );
      process.exit(1);
    }
  }
})();
