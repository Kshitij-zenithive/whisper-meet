const path = require('path');

module.exports = {
  entry: {
    background: './background.js',
    content: './content.js',
    popup: './popup.js'
  },
  output: {
    filename: '[name].js',
    path: path.resolve(__dirname, 'dist')
  },
  mode: 'production'
};