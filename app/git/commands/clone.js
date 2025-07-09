const https = require("https");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");

class CloneCommand {
    constructor(url, directory) {
        this.repoUrl = url;
        this.destDir = directory;
        this.parsedUrl = new URL(url);
    }

    async execute() {
        if (!this.repoUrl || !this.destDir) {
            console.error("Usage: clone <repo-url> <directory>");
            process.exit(1);
        }

        fs.mkdirSync(this.destDir, { recursive: true });
        process.chdir(this.destDir);

        this.createGitDirectory();

        const refsData = await this.fetchRefs();
        const headHash = this.extractHeadRef(refsData);

        const packData = await this.fetchPack(headHash);
        const objects = this.unpackPack(packData);

        this.writeObjects(objects);
        this.writeHEAD(headHash);

        console.log("Cloning completed.");
    }

    createGitDirectory() {
        fs.mkdirSync(".git/objects", { recursive: true });
        fs.mkdirSync(".git/refs/heads", { recursive: true });
    }

    fetchRefs() {
        const options = {
            hostname: this.parsedUrl.hostname,
            path: this.parsedUrl.pathname + "/info/refs?service=git-upload-pack",
            method: "GET",
            headers: { "User-Agent": "git/1.0" }
        };

        return this.httpRequest(options);
    }

    extractHeadRef(data) {
        const lines = data.split("\n");
        for (const line of lines) {
            if (line.includes("HEAD")) {
                return line.substring(4, 44); // skip pkt-line prefix
            }
        }
        throw new Error("HEAD ref not found");
    }

    async fetchPack(sha) {
        const body = this.buildUploadPackRequest(sha);
        const options = {
            hostname: this.parsedUrl.hostname,
            path: this.parsedUrl.pathname + "/git-upload-pack",
            method: "POST",
            headers: {
                "Content-Type": "application/x-git-upload-pack-request",
                "User-Agent": "git/1.0",
                "Content-Length": Buffer.byteLength(body)
            }
        };

        return this.httpRequest(options, body, true);
    }

    buildUploadPackRequest(sha) {
        const pkt = (s) => s.length ? `${(s.length + 4).toString(16).padStart(4, "0")}${s}` : "0000";
        return (
            pkt(`want ${sha} multi_ack_detailed side-band-64k thin-pack ofs-delta agent=git/1.0\n`) +
            pkt("") + // flush
            pkt("done\n")
        );
    }

    unpackPack(data) {
        const packSignature = Buffer.from("PACK");
        const packStart = data.indexOf(packSignature);

        if (packStart === -1) throw new Error("PACK header not found");

        const packBuffer = data.slice(packStart);
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
        let byte = buffer[offset];
        let type = (byte >> 4) & 0b111;
        let size = byte & 0b1111;
        let shift = 4;
        let i = 1;

        while (byte & 0b10000000) {
            byte = buffer[offset + i];
            size |= (byte & 0b01111111) << shift;
            shift += 7;
            i++;
        }

        const typeMap = { 1: "commit", 2: "tree", 3: "blob" };
        return {
            type: typeMap[type] || "unknown",
            size,
            headerSize: i
        };
    }

    readAndInflate(buffer) {
        for (let i = 1; i < buffer.length; i++) {
            try {
                const slice = buffer.slice(0, i);
                const inflated = zlib.inflateSync(slice);
                return { object: inflated, consumed: i };
            } catch (e) {
                continue;
            }
        }
        throw new Error("Unable to inflate object");
    }

    writeObjects(objects) {
        for (const sha in objects) {
            const folder = sha.slice(0, 2);
            const file = sha.slice(2);
            const dirPath = path.join(".git", "objects", folder);
            fs.mkdirSync(dirPath, { recursive: true });
            const compressed = zlib.deflateSync(objects[sha]);
            fs.writeFileSync(path.join(dirPath, file), compressed);
        }
    }

    writeHEAD(sha) {
        fs.writeFileSync(".git/HEAD", `ref: refs/heads/master\n`);
        fs.writeFileSync(".git/refs/heads/master", `${sha}\n`);
    }

    httpRequest(options, body = null, binary = false) {
        return new Promise((resolve, reject) => {
            const req = https.request(options, (res) => {
                const chunks = [];
                res.on("data", chunk => chunks.push(chunk));
                res.on("end", () => {
                    const result = Buffer.concat(chunks);
                    resolve(binary ? result : result.toString("utf-8"));
                });
            });
            req.on("error", reject);
            if (body) req.write(body);
            req.end();
        });
    }
}

module.exports = CloneCommand;