const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");

class CloneCommand {
    constructor(url, directory) {
        this.repoUrl = url.endsWith(".git") ? url : url + ".git";
        this.destDir = directory;
    }

    async execute() {
        if (!this.repoUrl || !this.destDir) {
            console.error("Usage: clone <repo-url> <directory>");
            process.exit(1);
        }

        fs.mkdirSync(this.destDir, { recursive: true });
        process.chdir(this.destDir);

        // Step 1: Create .git directory structure
        fs.mkdirSync(".git/objects", { recursive: true });
        fs.mkdirSync(".git/refs/heads", { recursive: true });

        // Step 2: Fetch refs
        const { hostname, pathname } = new URL(this.repoUrl);
        const refsBuffer = await this.httpGetBuffer({
            hostname,
            path: `${pathname}/info/refs?service=git-upload-pack`,
            headers: {
                'User-Agent': 'git/1.0',
            },
        });

        const refs = this.parseRefs(refsBuffer);
        const headHash = refs['HEAD'];
        if (!headHash) throw new Error("HEAD hash missing from refs");

        // Step 3: Fetch pack data
        const packData = await this.fetchPack(hostname, pathname, headHash);
        const objects = this.unpackPack(packData);

        // Step 4: Write objects
        for (const [sha, objectBuffer] of Object.entries(objects)) {
            const folder = sha.slice(0, 2);
            const file = sha.slice(2);
            const dirPath = path.join(".git", "objects", folder);
            fs.mkdirSync(dirPath, { recursive: true });
            fs.writeFileSync(
                path.join(dirPath, file),
                zlib.deflateSync(objectBuffer)
            );
        }

        // Step 5: Write HEAD and refs
        fs.writeFileSync(".git/HEAD", "ref: refs/heads/main\n");
        fs.writeFileSync(".git/refs/heads/main", headHash + "\n");

        console.log("Cloning completed.");
    }

    httpGetBuffer(options) {
        return new Promise((resolve, reject) => {
            const chunks = [];
            const req = https.request({ ...options, method: "GET" }, res => {
                res.on("data", chunk => chunks.push(chunk));
                res.on("end", () => resolve(Buffer.concat(chunks)));
            });
            req.on("error", reject);
            req.end();
        });
    }

    fetchPack(hostname, pathname, hash) {
        const body = Buffer.concat([
            this.encodePktLine(`0032want ${hash} multi_ack_detailed side-band-64k\n`),
            this.encodePktLine("00000009done\n"),
        ]);

        return new Promise((resolve, reject) => {
            const req = https.request({
                hostname,
                path: `${pathname}/git-upload-pack`,
                method: "POST",
                headers: {
                    "Content-Type": "application/x-git-upload-pack-request",
                    "User-Agent": "git/1.0",
                    "Accept": "*/*",
                    "Content-Length": body.length,
                },
            }, res => {
                const chunks = [];
                res.on("data", chunk => chunks.push(chunk));
                res.on("end", () => resolve(Buffer.concat(chunks)));
            });

            req.on("error", reject);
            req.write(body);
            req.end();
        });
    }

    encodePktLine(line) {
        const totalLength = (line.length + 4).toString(16).padStart(4, "0");
        return Buffer.from(totalLength + line, "utf8");
    }

    parseRefs(data) {
        const buffer = Buffer.from(data);
        let offset = 0;
        let refs = {};

        while (offset < buffer.length) {
            const lenHex = buffer.slice(offset, offset + 4).toString();
            const len = parseInt(lenHex, 16);
            if (len === 0) break;

            const line = buffer.slice(offset + 4, offset + len).toString();
            const [hash, ref] = line.trim().split(/\s+/);
            if (hash && ref) refs[ref] = hash;

            offset += len;
        }

        if (!refs['HEAD'] && refs['refs/heads/main']) {
            refs['HEAD'] = refs['refs/heads/main'];
        }

        if (!refs['HEAD']) {
            throw new Error("HEAD ref not found");
        }

        return refs;
    }

    unpackPack(buffer) {
        const packStart = buffer.indexOf(Buffer.from("PACK"));
        if (packStart === -1) throw new Error("PACK header not found");

        const packBuffer = buffer.slice(packStart);
        const count = packBuffer.readUInt32BE(8);
        let offset = 12;
        const objects = {};

        for (let i = 0; i < count; i++) {
            const { type, size, headerSize } = this.decodePackHeader(packBuffer, offset);
            offset += headerSize;

            const { object, consumed } = this.readAndInflate(packBuffer.slice(offset));
            offset += consumed;

            const header = `${type} ${object.length}\0`;
            const fullObject = Buffer.concat([Buffer.from(header), object]);
            const sha = crypto.createHash("sha1").update(fullObject).digest("hex");

            objects[sha] = fullObject;
        }

        return objects;
    }

    decodePackHeader(buffer, offset) {
        const byte = buffer[offset];
        const type = (byte >> 4) & 0b111;
        let size = byte & 0b1111;
        let shift = 4;
        let i = 1;

        while (byte & 0x80) {
            const b = buffer[offset + i];
            size |= (b & 0x7f) << shift;
            shift += 7;
            i++;
            if (!(b & 0x80)) break;
        }

        const typeMap = {
            1: "commit",
            2: "tree",
            3: "blob",
        };

        return {
            type: typeMap[type] || "unknown",
            size,
            headerSize: i,
        };
    }

    readAndInflate(slice) {
        for (let i = 1; i < slice.length; i++) {
            try {
                const out = zlib.inflateSync(slice.slice(0, i));
                return { object: out, consumed: i };
            } catch (e) {
                continue;
            }
        }
        throw new Error("Failed to inflate object");
    }
}

module.exports = CloneCommand;