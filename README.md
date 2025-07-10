This repo contains my implementation of git as part of the CodeCrafters challenge, written in JavaScript.

The goal was to recreate Git from scratch, building core features like:
	•	git init
	•	git hash-object
	•	git cat-file
	•	git commit
	•	git clone (Smart HTTP protocol, packfile unpacking, etc.)

I gained hands-on experience with:
	•	Git internals (objects, trees, commits, deltas)
	•	Packfile encoding/decoding
	•	Zlib compression, SHA-1 hashing
	•	Smart HTTP protocol for cloning
	•	Rebuilding the .git directory structure from raw bytes

⸻

⚠️ Note on Running Locally

To avoid accidentally modifying your real Git repo, you should not run your_program.sh from inside a Git repository (like this one). Instead, test it from a safe directory like /tmp.

Usage:
mkdir -p /tmp/git-test && cd /tmp/git-test
/path/to/your_program.sh init

To simplify usage, you can also create a shell alias:
alias mygit=/path/to/your_program.sh
mkdir -p /tmp/git-test && cd /tmp/git-test
mygit init

Features Implemented
	•	Git object creation and hashing
	•	Tree and commit object serialization
	•	Git repository initialization
	•	Custom packfile parsing & object unpacking (for git clone)
	•	SHA-1-based object storage
	•	Smart HTTP protocol handling

 Debugging the Final Stretch

The last challenge — unpacking and reconstructing Git objects from a packfile during git clone — was the most difficult and time-consuming. After extensive trial and error, I turned to Claude AI, which helped me trace a subtle zlib offset issue and finalize the solution.

⸻

📚 Learnings

This challenge was an incredible way to understand how Git actually works under the hood. It gave me hands-on exposure to zlib compression, SHA-1 hashing, binary formats, and low-level Git plumbing commands.
