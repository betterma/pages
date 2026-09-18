"use strict";

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const dest = path.join(root, "www");
const files = [
  "index.html",
  "chats.html",
  "chat.html",
  "admin.html",
  "styles.css",
  "app.js",
  "chat-store.js",
  "admin.js",
];

fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });

files.forEach((name) => {
  fs.copyFileSync(path.join(root, name), path.join(dest, name));
});

fs.cpSync(path.join(root, "data"), path.join(dest, "data"), { recursive: true });
console.log("copied web assets to www/");
