const https = require("https");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");

function findZlibStart(buffer) {
    // Look for zlib header patterns
    for (let i = 0; i < Math.min(20, buffer.length - 1); i++) {
        const byte1 = buffer[i];
        const byte2 = buffer[i + 1];
        
        // Check for common zlib headers
        if (byte1 === 0x78) {
            if (byte2 === 0x9c || byte2 === 0x01 || byte2 === 0xda || byte2 === 0x5e) {
                return i;
            }
        }
    }
    return 0;
}

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

        console.log("Ref data:\n", refsData);

        const headSHA = this.extractHeadSHA(refsData);

        console.log("HEAD SHA:", headSHA);
        if (!/^[a-f0-9]{40}$/.test(headSHA)) {
            throw new Error("Invalid HEAD SHA received: " + headSHA);
        }

        console.log("✅ Correct HEAD SHA:", headSHA);

        const packResponse = await this.fetchPackfile(headSHA);
        const packData = this.extractPackData(packResponse);

        const objects = this.unpackPackfile(packData);
        this.writeGitObjects(objects);
        this.writeHEADFile(headSHA);

        // NEW: Checkout the working directory files
        await this.checkoutWorkingDirectory(headSHA, objects);

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
            const shaMatch = line.match(/^....([a-f0-9]{40})\s+refs\/heads\/master/);
            if (shaMatch) {
                return shaMatch[1]; // only return the matched SHA
            }
        }

        throw new Error("HEAD ref not found in refs.");
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
        const packStart = buffer.indexOf(Buffer.from("PACK"));
        if (packStart === -1) throw new Error("PACK header not found");

        const pack = buffer.slice(packStart);
        if (pack.length < 12) throw new Error("Corrupted PACK file");

        const objectCount = pack.readUInt32BE(8);
        let offset = 12;
        const objects = {};
        
        console.log(`Processing ${objectCount} objects from pack file`);

        for (let i = 0; i < objectCount; i++) {
            try {
                const startOffset = offset;
                const { type, size, headerSize } = this.decodePackHeader(pack, offset);

                console.log(`→ Object ${i + 1}/${objectCount}, type: ${type}, size: ${size}, offset: ${offset}`);
                
                offset += headerSize;

                if (type === "ref-delta" || type === "ofs-delta") {
                    console.log(`⚠️ Skipping delta object (type: ${type})`);
                    
                    // For ref-delta, skip the 20-byte base SHA
                    if (type === "ref-delta") {
                        offset += 20;
                    }
                    
                    // For ofs-delta, skip the negative offset varint
                    if (type === "ofs-delta") {
                        while (pack[offset] & 0x80) {
                            offset++;
                        }
                        offset++; // skip the last byte
                    }
                    
                    // Skip the compressed delta data
                    // We'll use a simple approach: try to find the next object header
                    let nextObjectFound = false;
                    
                    // Start searching from current position
                    for (let searchPos = offset; searchPos < pack.length - 10; searchPos++) {
                        try {
                            // Try to decode a potential object header at this position
                            const testHeader = this.decodePackHeader(pack, searchPos);
                            
                            // Check if this is a valid non-delta object type
                            if (testHeader.type === "commit" || testHeader.type === "tree" || 
                                testHeader.type === "blob" || testHeader.type === "tag") {
                                
                                // Verify there's zlib data after the header
                                const afterHeader = searchPos + testHeader.headerSize;
                                const zlibCheck = this.findZlibAtPosition(pack, afterHeader);
                                
                                if (zlibCheck !== -1) {
                                    offset = searchPos;
                                    nextObjectFound = true;
                                    console.log(`✔️ Found next object at offset: ${offset}`);
                                    break;
                                }
                            }
                        } catch (e) {
                            // Continue searching
                        }
                    }
                    
                    if (!nextObjectFound) {
                        console.warn(`⚠️ Could not find next object after ${type}, stopping parsing`);
                        break;
                    }
                    
                    // Continue to next iteration without processing this delta
                    continue;
                }

                // Process regular objects (commit, tree, blob, tag)
                const zlibStart = this.findZlibAtPosition(pack, offset);
                if (zlibStart === -1) {
                    console.warn(`⚠️ No zlib data found for ${type} object at offset ${offset}`);
                    continue;
                }
                
                offset = zlibStart;
                
                try {
                    const { object, consumed } = this.readInflatedObject(pack.slice(offset));
                    offset += consumed;

                    const header = `${type} ${object.length}\0`;
                    const fullObject = Buffer.concat([Buffer.from(header), object]);
                    const sha = crypto.createHash("sha1").update(fullObject).digest("hex");

                    objects[sha] = fullObject;
                    console.log(`✔️ Processed ${type} object: ${sha}`);
                } catch (err) {
                    console.warn(`⚠️ Failed to process ${type} object at offset ${offset}: ${err.message}`);
                    continue;
                }
                
            } catch (err) {
                console.warn(`⚠️ Error processing object ${i + 1}: ${err.message}`);
                break;
            }
        }

        console.log(`Successfully processed ${Object.keys(objects).length} objects`);
        return objects;
    }

    findZlibAtPosition(buffer, startPos) {
        // Look for zlib header within reasonable range
        for (let i = 0; i < 20 && startPos + i < buffer.length - 1; i++) {
            const pos = startPos + i;
            const byte1 = buffer[pos];
            const byte2 = buffer[pos + 1];
            
            // Check for zlib magic bytes
            if (byte1 === 0x78 && (byte2 === 0x9c || byte2 === 0x01 || byte2 === 0xda || byte2 === 0x5e)) {
                return pos;
            }
        }
        return -1;
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

        const typeMap = {
            1: "commit",
            2: "tree",
            3: "blob",
            4: "tag",
            6: "ref-delta",
            7: "ofs-delta"
        };

        return {
            type: typeMap[type] || "unknown",
            size,
            headerSize: i
        };
    }

    readInflatedObject(buffer) {
        for (let i = 30; i < buffer.length; i++) {
            try {
                const slice = buffer.slice(0, i);
                const inflated = zlib.inflateSync(slice);
                return { object: inflated, consumed: i };
            } catch (err) {
                // Continue trying if it's just a truncated stream
                if (err.code === "Z_BUF_ERROR" || err.message.includes("unexpected end of file")) {
                    continue;
                } else {
                    throw err;
                }
            }
        }
        throw new Error("Inflate failed");
    }

    // NEW: Checkout working directory files
    async checkoutWorkingDirectory(headSHA, objects) {
        console.log("Checking out working directory files...");
        
        // Find the commit object
        const commitObject = this.findObjectByHash(headSHA, objects);
        if (!commitObject) {
            throw new Error(`Commit object ${headSHA} not found`);
        }

        // Parse the commit to find the tree SHA
        const commitContent = this.parseGitObject(commitObject);
        const treeSHA = this.extractTreeSHA(commitContent);
        
        console.log("Tree SHA:", treeSHA);

        // Find the tree object
        const treeObject = this.findObjectByHash(treeSHA, objects);
        if (!treeObject) {
            throw new Error(`Tree object ${treeSHA} not found`);
        }

        // Parse and checkout the tree
        const treeContent = this.parseGitObject(treeObject);
        await this.checkoutTree(treeContent, objects, "");
    }

    findObjectByHash(sha, objects) {
        return objects[sha] || null;
    }

    parseGitObject(objectBuffer) {
        // Find the null byte that separates header from content
        const nullIndex = objectBuffer.indexOf(0);
        if (nullIndex === -1) {
            throw new Error("Invalid Git object format");
        }
        
        const header = objectBuffer.slice(0, nullIndex).toString();
        const content = objectBuffer.slice(nullIndex + 1);
        
        const [type, size] = header.split(' ');
        return { type, size: parseInt(size), content };
    }

    extractTreeSHA(commitContent) {
        const lines = commitContent.content.toString().split('\n');
        for (const line of lines) {
            if (line.startsWith('tree ')) {
                return line.substring(5);
            }
        }
        throw new Error("Tree SHA not found in commit");
    }

    async checkoutTree(treeContent, objects, basePath) {
        let offset = 0;
        const content = treeContent.content;
        
        while (offset < content.length) {
            // Find the next null byte (end of filename)
            const nullIndex = content.indexOf(0, offset);
            if (nullIndex === -1) break;
            
            // Parse the entry: "mode filename\0<20-byte-sha>"
            const entry = content.slice(offset, nullIndex).toString();
            const [mode, filename] = entry.split(' ');
            
            // Extract the 20-byte SHA
            const sha = content.slice(nullIndex + 1, nullIndex + 21);
            const shaHex = sha.toString('hex');
            
            const filePath = path.join(basePath, filename);
            
            console.log(`Checking out: ${filePath} (${mode}, ${shaHex})`);
            
            if (mode === '40000') {
                // This is a subdirectory
                fs.mkdirSync(filePath, { recursive: true });
                
                const subTreeObject = this.findObjectByHash(shaHex, objects);
                if (subTreeObject) {
                    const subTreeContent = this.parseGitObject(subTreeObject);
                    await this.checkoutTree(subTreeContent, objects, filePath);
                }
            } else {
                // This is a file
                const blobObject = this.findObjectByHash(shaHex, objects);
                if (blobObject) {
                    const blobContent = this.parseGitObject(blobObject);
                    
                    // Ensure the directory exists
                    const dir = path.dirname(filePath);
                    if (dir !== '.') {
                        fs.mkdirSync(dir, { recursive: true });
                    }
                    
                    // Write the file
                    fs.writeFileSync(filePath, blobContent.content);
                    
                    // Set file permissions if needed
                    if (mode === '100755') {
                        fs.chmodSync(filePath, 0o755);
                    }
                }
            }
            
            // Move to the next entry
            offset = nullIndex + 21;
        }
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