# Intent: Add QQ channel import

Add `import './qq.js';` to the channel barrel file so the QQ
module self-registers with the channel registry on startup.

This is an append-only change — existing import lines for other channels
must be preserved.
