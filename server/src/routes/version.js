const express = require('express');
const { getMinVersion } = require('../lib/version');

const router = express.Router();

/**
 * Public endpoint: returns the required minimum version of the Android app.
 * Called on app launch and on foreground resume to check whether normal app
 * use must be blocked by the required-update screen.
 */
router.get('/', async (req, res) => {
  const minVersion = await getMinVersion();
  res.json({ min_version: minVersion });
});

module.exports = router;
