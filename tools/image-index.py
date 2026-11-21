#!/usr/bin/env python3
"""image-index.py TAG DIR: print images/index.json for the mirrored thingino QEMU images."""
import json
import os
import sys

tag, d = sys.argv[1], sys.argv[2]
images = []
for f in sorted(os.listdir(d)):
    if f.startswith("thingino-qemu_") and f.endswith(".bin"):
        images.append({"id": f[:-4], "file": f, "name": f[len("thingino-"):-4],
                       "size": os.path.getsize(os.path.join(d, f))})
json.dump({"release": tag, "images": images}, sys.stdout, indent=1)
