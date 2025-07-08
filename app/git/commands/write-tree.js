const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const zlib = require('zlib');

function writeFileBlob(currentPath) {
    const contents = fs.readFileSync(currentPath);
    const len = contents.length;

    const header = `blob ${len}\0`;
    const blob = Buffer.concat([Buffer.from(header), contents]);

    const hash = crypto.createHash("sha1").update(blob).digest("hex");

    const folder = hash.slice(0, 2);
    const file = hash.slice(2);

    const completeFolderPath = path.join(process.cwd(), '.git', 'objects', folder);

    if (!fs.existsSync(completeFolderPath)) {
        fs.mkdirSync(completeFolderPath, { recursive: true });
    }

    const compressData = zlib.deflateSync(blob)
    fs.writeFileSync(
        path.join(completeFolderPath, file), compressData
    );

    return hash;
}

class WriteTreeCommand {
    constructor() { }

    execute() {
        //recirsive read all files and dir
        function recursiveCreateTree(basePath) {
            const dirContents = fs.readFileSync(basePath);
            const result = [];

            for (const dirContent of dirContents) {
                if (dirContent.includes(".git")) continue;

                const currentPath = path.join(basePath, dirContent);
                const stat = fs.statSync(currentPath);

                if (stat.isDirectory()) {
                    const sha = recursiveCreateTree(currentPath);
                    if (sha) {
                        result.push({
                            mode: "40000",
                            basename: path.basename(currentPath),
                            sha,
                        });
                    }
                } else if (stat.isFile()) {
                    const sha = writeFileBlob(currentPath);
                    result.push({
                        mode: "100644",
                        basename: path.basename(currentPath),
                        sha,
                    });
                }
            }

            if (dirContents.length === 0 || result.length === 0) return null;
            const treeData = result.reduce((acc, current) => {
                const { mode, basename, sha } = current;
                return Buffer.concat([acc, Buffer.from(`${mode} ${basename}\0`), Buffer.from(sha, "hex"),]);
            }, Buffer.alloc(0));

            const tree = Buffer.concat([Buffer.from(`tree ${treeData.length}\0`), treeData]);

            const hash = crypto.createHash('sha1').update(tree).digest('hex');

            const folder = hash.slice(0, 2);
            const file = hash.slice(2);

            const treeFolderPath = path.join(process.cwd(), '.git', 'objects', folder)

            if (!fs.existsSync(treeFolderPath)) {
                fs.mkdirSync(treeFolderPath);
            }

            const compressed = zlib.deflateSync(tree)
            fs.writeFileSync(path.join(treeFolderPath, file), compressed);

            return hash;

        }

        const sha = recursiveCreateTree(process.cwd());
        process.stdout.write(sha);
        //if item is dir do it again for in a dir 
        //if file, create a blob, write hash and file to objects and write the entry to tree
    }
}

module.exports = WriteTreeCommand;