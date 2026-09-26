mediabunny 1.60.0（MPL-2.0）
https://github.com/Vanilagy/mediabunny

npm の mediabunny@1.60.0 から dist/bundles/mediabunny.mjs と dist/mediabunny.d.ts（型定義は .d.mts として置いています）を無改変で置いています。

MPL-2.0 はファイル単位のコピーレフトです。このフォルダのファイルは改変しないでください（改変する場合は、そのファイルを MPL-2.0 で公開する義務が生じます）。
「無改変であること」がライセンス上の立ち位置を支えているので、置いてあるものの指紋を残しておきます。

| ファイル | sha256 |
|---|---|
| `mediabunny.mjs` | `bf3eddc2e8c16f5509ec353bb0a7fdd09edb25bcdb57d817c1a022ae9f7d9c1a` |
| `mediabunny.d.mts` | `46ae7b09e20d89ce20301f9a097f0601575944c4460100d52ee4594dfb6eccf0` |

手元で確かめる：

```sh
shasum -a 256 vendor/mediabunny/mediabunny.mjs vendor/mediabunny/mediabunny.d.mts
```

上流と突き合わせる：

```sh
npm pack mediabunny@1.60.0 && tar xzf mediabunny-1.60.0.tgz
shasum -a 256 package/dist/bundles/mediabunny.mjs package/dist/mediabunny.d.ts
```
