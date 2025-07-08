const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

class CloneCommand {
    constructor(url, directory) {
        this.repoUrl = url;
        this.destDir = directory;
    }

    async execute() {
        if (!this.repoUrl || !this.destDir) {
            console.error("Usage: clone <repo-url> <directory>");
            process.exit(1);
        }

        fs.mkdirSync(this.destDir, { recursive: true });
        process.chdir(this.destDir);

        const { hostname, pathname } = new URL(this.repoUrl);
        const infoPath = `${pathname}/info/refs?service=git-upload-pack`;

        const refsData = await this.httpRequest({
            hostname,
            path: infoPath,
            method: 'GET',
            headers: {
                'User-Agent': 'git/1.0'
            }
        });

        const { headSha, capabilities } = this.parseRefs(refsData);
        await this.fetchPack(hostname, pathname, headSha);
        this.writeGitMetadata(headSha);

        console.log("Cloning completed.");
    }

    httpRequest(options, body = null) {
        return new Promise((resolve, reject) => {
            const req = https.request(options, res => {
                const chunks = [];
                res.on('data', chunk => chunks.push(chunk));
                res.on('end', () => resolve(Buffer.concat(chunks)));
            });
            req.on('error', reject);
            if (body) req.write(body);
            req.end();
        });
    }

    parseRefs(buffer) {
        const data = buffer.toString();
        const lines = data.split('\n');
        for (let line of lines) {
            if (line.includes('HEAD')) {
                const sha = line.slice(4, 44);
                return { headSha: sha, capabilities: line.split('\0')[1] || '' };
            }
        }
        throw new Error("HEAD ref not found.");
    }

    async fetchPack(hostname, pathname, headSha) {
        const body = this.buildUploadPackRequest(headSha);

        const response = await this.httpRequest({
            hostname,
            path: `${pathname}/git-upload-pack`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-git-upload-pack-request',
                'Accept': 'application/x-git-upload-pack-result'
            }
        }, body);

        const packDataIndex = response.indexOf(Buffer.from('PACK'));
        const packData = response.slice(packDataIndex);
        this.unpackPack(packData);
    }

    buildUploadPackRequest(sha) {
        const pktLine = str => {
            const len = (str.length + 4).toString(16).padStart(4, '0');
            return len + str;
        };

        let out = '';
        out += pktLine(`want ${sha}\n`);
        out += pktLine('done\n');
        out += '0000';
        return Buffer.from(out, 'utf8');
    }

    unpackPack(pack) {
        const objectsDir = path.join('.git', 'objects');
        fs.mkdirSync(objectsDir, { recursive: true });

        // Very basic handling of single-commit packs.
        // Full unpacking support requires parsing pack format spec.

        // Write the raw pack for now (simplified)
        fs.writeFileSync(path.join(objectsDir, 'raw.pack'), pack);
        // TODO: Parse the pack and inflate objects into their object dirs
    }

    writeGitMetadata(headSha) {
        const gitDir = path.join(process.cwd(), '.git');
        fs.mkdirSync(path.join(gitDir, 'objects'), { recursive: true });
        fs.mkdirSync(path.join(gitDir, 'refs', 'heads'), { recursive: true });
        fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
        fs.writeFileSync(path.join(gitDir, 'refs', 'heads', 'main'), headSha);
    }
}

module.exports = CloneCommand;