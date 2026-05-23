const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const port = process.env.PORT || 5000;

app.get('/', (req, res) => {
  res.send('Welcome to Decor Nest!')
});

app.listen(port, () => {
  console.log(`Decor Nest listening on port ${port}`)
});