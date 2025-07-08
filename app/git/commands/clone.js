// clone.js
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const zlib = require('zlib');
const crypto = require('crypto');

function encodePktLine(line) {
  const len = (line.length + 4).toString(16).padStart(4, '0');
  return len + line;
}

function decodeSideBand(buffer) {
  const result = [];
  let offset = 0;

  while (offset < buffer.length) {
    const length = parseInt(buffer.slice(offset, offset + 4).toString(), 16);
    if (length === 0) break;
    const band = buffer[offset + 4];
    const chunk = buffer.slice(offset + 5, offset + length);
    if (band === 1) result.push(chunk); // data band
    offset += length;
  }
  return Buffer.concat(result);
}

function writeObject(type, content) {
  const header = `${type} ${content.length}\0`;
  const store = Buffer.concat([Buffer.from(header), content]);
  const hash = crypto.createHash('sha1').update(store).digest('hex');

  const folder = hash.slice(0, 2);
  const file = hash.slice(2);
  const objPath = path.join('.git', 'objects', folder);
  if (!fs.existsSync(objPath)) fs.mkdirSync(objPath);
  const compressed = zlib.deflateSync(store);
  fs.writeFileSync(path.join(objPath, file), compressed);
  return hash;
}

class CloneCommand {
  constructor(repoUrl, targetDir) {
    this.repoUrl = repoUrl.replace(/\.git$/, '');
    this.targetDir = targetDir;
  }

  async execute() {
    fs.mkdirSync(this.targetDir);
    process.chdir(this.targetDir);
    fs.mkdirSync('.git/objects', { recursive: true });
    fs.mkdirSync('.git/refs', { recursive: true });

    const { sha } = await this.fetchRefs();
    const pack = await this.fetchPack(sha);
    const unpacked = decodeSideBand(pack);
    this.unpackPack(unpacked);

    fs.writeFileSync('.git/HEAD', 'ref: refs/heads/main\n');
  }

  fetchRefs() {
    return new Promise((resolve) => {
      const { hostname, pathname } = new URL(this.repoUrl);
      const options = {
        hostname,
        path: pathname + '/info/refs?service=git-upload-pack',
        headers: { 'User-Agent': 'git/1.0' }
      };

      https.get(options, (res) => {
        let data = [];
        res.on('data', chunk => data.push(chunk));
        res.on('end', () => {
          const buffer = Buffer.concat(data);
          const lines = buffer.toString().split('\n');
          const shaLine = lines.find(line => line.includes('HEAD'));
          const sha = shaLine?.match(/[a-f0-9]{40}/)?.[0];
          resolve({ sha });
        });
      });
    });
  }

  fetchPack(sha) {
    return new Promise((resolve) => {
      const { hostname, pathname } = new URL(this.repoUrl);
      const body = Buffer.from(
        encodePktLine(`want ${sha}\n`) +
        '00000009done\n',
        'utf8'
      );

      const options = {
        hostname,
        path: pathname + '/git-upload-pack',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-git-upload-pack-request',
          'Accept': 'application/x-git-upload-pack-result',
          'Content-Length': body.length
        }
      };

      const req = https.request(options, (res) => {
        let chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      });
      req.write(body);
      req.end();
    });
  }

  unpackPack(packBuffer) {
    if (!packBuffer.slice(0, 4).toString() === 'PACK') return;
    // Minimal parsing here - assume single commit/blob object for simplicity
    // Full parsing: parse header, object count, type/size, delta refs, etc.
    // Instead, we'll just store the raw pack file to demonstrate cloning
    fs.writeFileSync('.git/packfile.pack', packBuffer);
  }
}

module.exports = CloneCommand;