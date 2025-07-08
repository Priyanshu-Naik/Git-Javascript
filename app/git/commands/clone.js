const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const zlib = require('zlib');

class CloneCommand {
    constructor(url, directory) {
        this.repoUrl = url;
        this.destDir = directory;
        this.repoName = path.basename(url, '.git');
    }

    async execute() {
        if (!this.repoUrl || !this.destDir) {
            console.error("Usage: clone <repo-url> <directory>");
            process.exit(1);
        }

        // 1. Create destination directory
        fs.mkdirSync(this.destDir, { recursive: true });

        // 2. Prepare to fetch refs from info/refs
        const { hostname, pathname } = new URL(this.repoUrl);
        const options = {
            hostname,
            path: pathname + '/info/refs?service=git-upload-pack',
            method: 'GET',
            headers: {
                'User-Agent': 'git/1.0',
            }
        };

        const refsData = await this.httpRequest(options);
        this.parseRefs(refsData);

        // 3. TODO: Create .git directory, send POST to /git-upload-pack, parse packfile etc.
        // You'll read/write .git/HEAD, .git/refs/heads/*, and .git/objects/*
        console.log(`Step 1 complete. You'll now need to implement fetch-pack, parse-pack.`);
    }

    httpRequest(options) {
        return new Promise((resolve, reject) => {
            let data = '';
            const req = https.request(options, (res) => {
                res.on('data', chunk => data += chunk);
                res.on('end', () => resolve(data));
            });
            req.on('error', reject);
            req.end();
        });
    }

    parseRefs(data) {
        console.log("Received refs:");
        console.log(data.substring(0, 200)); // Display the first few lines for debugging
    }
}

module.exports = CloneCommand;