#!/usr/bin/env node
const path = require('path');
const { startImageProcess, startVideoProcess } = require(path.join(__dirname, 'src'));
const argv = require('yargs')
  .command('optimise:image', 'Optimise images', {
    'loadFolder': {
      describe: 'Path to the image folder',
      demandOption: true,
      type: 'string'
    },
    'quality': {
      describe: 'Quality parameter (between 10 and 100)',
      default: 20,
      type: 'number',
      coerce: (quality) => {
        if (quality < 10) {
          throw new Error('Quality cannot be less than 10.');
        }
        if (quality > 100) {
          throw new Error('Quality cannot be more than 100.');
        }
        return quality;
      }
    }
  })
  .command('optimise:video', 'Optimise videos', {
    'loadFolder': {
      describe: 'Path to the video folder',
      demandOption: true,
      type: 'string'
    },
    'quality': {
      describe: 'Quality parameter (between 10 and 100)',
      default: 20,
      type: 'number',
      coerce: (quality) => {
        if (quality < 10) {
          throw new Error('Quality cannot be less than 10.');
        }
        if (quality > 100) {
          throw new Error('Quality cannot be more than 100.');
        }
        return quality;
      }
    }
  })
  .scriptName('imgvidcompress')
  .usage('Usage: imgvidcompress <command> [options]')
  .example('imgvidcompress optimise:image --loadFolder="/path/to/images" --quality=80')
  .example('imgvidcompress optimise:video --loadFolder="/path/to/videos" --quality=50')
  .epilogue('For more information, visit: https://www.rohanpoudel.com.np')
  .help()
  .argv;

(() => {
  const { _ } = argv;
  const command = _[0];

  const loadFolder = argv.loadFolder.replace(/["']/g, "");
  const quality = parseInt(argv.quality.toString().replace(/["']/g, ""));

  switch (command) {
    case 'optimise:image': {
      startImageProcess(loadFolder, quality);
      break;
    }
    case 'optimise:video': {
      startVideoProcess(loadFolder, quality);
      break;
    }
    default: {
      console.error('Invalid command. Use "optimise:image" or "optimise:video"');
      process.exit(1);
    }
  }
})();
