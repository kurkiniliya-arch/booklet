# Book textures

The book-and-quill icon and book UI textures are downloaded, unchanged, from
the official Mojang `bedrock-samples` repository. They are copyright Mojang AB
and remain subject to its `LICENSE-Mojang.md`; the app's license does not apply
to these files. This independent personal project is not affiliated with Mojang.

The PNG files and packaged Windows icons are not redistributed in this source
repository. `npm run prepare:assets` downloads the pinned originals and checks
their SHA-256 values using `scripts/minecraft-assets.json`. It also packages the
icon for Windows using nearest-neighbour scaling, preserving the sprite pixels.
The resulting local application works offline.

Source: https://github.com/Mojang/bedrock-samples/tree/main/resource_pack/textures
