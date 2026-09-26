// 書き出したファイルを保存する
// 保存は「押した瞬間」に呼ぶ。変換が終わってから押してもらう作りにしているのは、
// 保存先を選ぶ窓が、人が押した直後にしか開けないため
// @ts-check

/**
 * @param {Blob} blob
 * @param {string} name
 * @returns {Promise<'picked'|'downloaded'|'cancelled'>}
 */
export async function saveBlob(blob, name) {
  const picker = /** @type {any} */ (window).showSaveFilePicker;
  if (typeof picker === 'function') {
    try {
      const handle = await picker({
        suggestedName: name,
        types: [{ description: 'MP4', accept: { 'video/mp4': ['.mp4'] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return 'picked';
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return 'cancelled';
      }
      // 選ぶ窓が使えないときは、ふつうの取り込みに切り替える
    }
  }
  download(blob, name);
  return 'downloaded';
}

/**
 * @param {Blob} blob
 * @param {string} name
 */
function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // すぐ消すと保存が間に合わないことがあるので、少し置いてから片付ける
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
