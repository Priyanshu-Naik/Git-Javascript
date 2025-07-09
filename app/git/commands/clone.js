const https = require("https");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");

class CloneCommand {
    constructor(url, directory) {
        this.repoUrl = url.endsWith(".git") ? url : url + ".git";
        this.destDir = directory;
        this.parsedUrl = new URL(this.repoUrl);
    }

    async execute() {
        if (!this.repoUrl || !this.destDir) {
            console.error("Usage: clone <repo-url> <directory>");
            process.exit(1);
        }

        fs.mkdirSync(this.destDir, { recursive: true });
        process.chdir(this.destDir);
        this.initGitDirectory();

        const refsData = await this.fetchRefs();
        const headSHA = this.extractHeadSHA(refsData);

        console.log("HEAD SHA:", headSHA);
        if (!/^[a-f0-9]{40}$/.test(headSHA)) {
            throw new Error("Invalid HEAD SHA received: " + headSHA);
        }

        const packResponse = await this.fetchPackfile(headSHA);
        const packData = this.extractPackData(packResponse);

        const objects = this.unpackPackfile(packData);
        this.writeGitObjects(objects);
        this.writeHEADFile(headSHA);

        console.log("Cloning completed.");
    }

    initGitDirectory() {
        fs.mkdirSync(".git/objects", { recursive: true });
        fs.mkdirSync(".git/refs/heads", { recursive: true });
    }

    fetchRefs() {
        const options = {
            hostname: this.parsedUrl.hostname,
            path: `${this.parsedUrl.pathname}/info/refs?service=git-upload-pack`,
            method: "GET",
            headers: {
                "User-Agent": "git/1.0"
            }
        };
        return this.httpRequest(options);
    }

    extractHeadSHA(refData) {
        const lines = refData.split("\n");
        for (const line of lines) {
            if (line.includes("HEAD")) {
                const match = line.match(/[a-f0-9]{40}/);
                if (match) return match[0];
            }
        }
        throw new Error("HEAD ref not found.");
    }

    async fetchPackfile(sha) {
        const body = this.buildUploadPackRequest(sha);
        const options = {
            hostname: this.parsedUrl.hostname,
            path: `${this.parsedUrl.pathname}/git-upload-pack`,
            method: "POST",
            headers: {
                "Content-Type": "application/x-git-upload-pack-request",
                "User-Agent": "git/1.0",
                "Content-Length": Buffer.byteLength(body)
            }
        };

        console.log("Uploading to:", options.path);
        console.log("WANT request:\n", body.toString());

        const response = await this.httpRequest(options, body, true);

        fs.writeFileSync("raw-pack-response.bin", response); // Save for inspection
        console.log("Response length:", response.length);
        console.log("First bytes:", response.slice(0, 16).toString("hex"));

        return response;
    }

    buildUploadPackRequest(sha) {
        const pktLine = (s) => s ? `${(s.length + 4).toString(16).padStart(4, "0")}${s}` : "0000";
        return (
            pktLine(`want ${sha} side-band-64k ofs-delta agent=git/1.0\n`) +
            pktLine("") + // flush after want
            pktLine("done\n")
        );
    }

    extractPackData(responseBuffer) {
        const chunks = [];
        let offset = 0;

        while (offset + 4 <= responseBuffer.length) {
            const lengthHex = responseBuffer.toString("utf8", offset, offset + 4);
            const length = parseInt(lengthHex, 16);
            if (length === 0) break;

            const band = responseBuffer[offset + 4];
            const data = responseBuffer.slice(offset + 5, offset + length);

            if (band === 1) chunks.push(data);
            offset += length;
        }

        return Buffer.concat(chunks);
    }

    unpackPackfile(buffer) {
        const packStart = buffer.indexOf(Buffer.from("PACK")); // ✅ correct        
        if (packStart === -1) throw new Error("PACK header not found");

        const pack = buffer.slice(packStart);
        if (pack.length < 12) throw new Error("Corrupted PACK file");

        const objectCount = pack.readUInt32BE(8);
        let offset = 12;
        const objects = {};

        for (let i = 0; i < objectCount; i++) {
            const { type, size, headerSize } = this.decodePackHeader(pack, offset);
            offset += headerSize;

            const { object, consumed } = this.readInflatedObject(pack.slice(offset));
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
        let type = (byte >> 4) & 0x7;
        let size = byte & 0xf;
        let shift = 4;
        let i = 1;

        while (byte & 0x80) {
            byte = buffer[offset + i];
            size |= (byte & 0x7f) << shift;
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

    readInflatedObject(buffer) {
        for (let i = 1; i < buffer.length; i++) {
            try {
                const inflated = zlib.inflateSync(buffer.slice(0, i));
                return { object: inflated, consumed: i };
            } catch {
                continue;
            }
        }
        throw new Error("Inflate failed");
    }

    writeGitObjects(objects) {
        for (const sha in objects) {
            const dir = sha.slice(0, 2);
            const file = sha.slice(2);
            const objectDir = path.join(".git", "objects", dir);
            fs.mkdirSync(objectDir, { recursive: true });

            const compressed = zlib.deflateSync(objects[sha]);
            fs.writeFileSync(path.join(objectDir, file), compressed);
        }
    }

    writeHEADFile(sha) {
        fs.writeFileSync(".git/HEAD", "ref: refs/heads/master\n");
        fs.writeFileSync(".git/refs/heads/master", `${sha}\n`);
    }

    httpRequest(options, body = null, binary = false) {
        return new Promise((resolve, reject) => {
            const req = https.request(options, (res) => {
                const chunks = [];
                res.on("data", (chunk) => chunks.push(chunk));
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