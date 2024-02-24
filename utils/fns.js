module.exports = {
  processExtension: ext => ext.includes('.') ? ext : `.${ext}`
}