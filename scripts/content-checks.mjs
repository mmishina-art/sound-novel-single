// 内容の整合チェックの中身（scripts/check-content.mjs から呼ばれる）。
// 正本は data/chapters.json（原稿 manuscript/story.md から work/build_data.py が生成）。
// その派生物（配信コピー public/book/data.json、朗読音声、unitTimes、ルビ、読み辞書）が
// 食い違っていないかを確かめる検査を、ここに { id, title, run } で足す。
// run はエラーの文言の配列を返す（問題がなければ空）。ctx.root はリポジトリのルートのパス。
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const readJson = (root, rel) => JSON.parse(readFileSync(join(root, rel), 'utf8'));

/* src/logic.ts の splitSentences / buildUnits と同じ規則で文単位を数える
   （ルビの内側では割らない。閉じ括弧類は前の文に付ける。'---' の段落は区切り単位1つ） */
function splitSentences(text) {
  const out = [];
  let buf = '';
  let inRuby = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    buf += c;
    if (c === '《') inRuby = true;
    else if (c === '》') inRuby = false;
    else if (c === '。' && !inRuby) {
      while (i + 1 < text.length && '」』）】〉・…'.indexOf(text[i + 1]) >= 0) {
        buf += text[++i];
      }
      out.push(buf);
      buf = '';
    }
  }
  if (buf) out.push(buf);
  return out;
}

function countUnits(ch) {
  const src = ch.ruby && ch.ruby.length ? ch.ruby : ch.paragraphs || [];
  let n = 0;
  for (const p of src) n += p.trim() === '---' ? 1 : splitSentences(p).length;
  return n;
}

/** ffprobe でメディアの実尺（秒）を取る。ffprobe が無い環境では null（呼び出し側でエラーにする） */
function mediaDuration(path) {
  try {
    const out = execFileSync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path],
      { encoding: 'utf8' },
    );
    const d = Number.parseFloat(out.trim());
    return Number.isFinite(d) ? d : null;
  } catch {
    return null;
  }
}

export const checks = [
  {
    id: 'book-data-sync',
    title: '正本 data/chapters.json と配信コピー public/book/data.json が一致する',
    run({ root }) {
      const src = readJson(root, 'data/chapters.json');
      const pub = readJson(root, 'public/book/data.json');
      return JSON.stringify(src) === JSON.stringify(pub)
        ? []
        : ['data/chapters.json と public/book/data.json の内容が違います（work/build_data.py で作り直してください）'];
    },
  },
  {
    id: 'unit-times',
    title: 'unitTimes が文単位の数と合い、先頭 0・単調非減少である',
    run({ root }) {
      const book = readJson(root, 'data/chapters.json');
      const errors = [];
      for (const ch of book.chapters) {
        const units = countUnits(ch);
        const t = ch.unitTimes;
        if (!Array.isArray(t)) {
          errors.push(`${ch.id}: unitTimes がありません`);
          continue;
        }
        if (t.length !== units) errors.push(`${ch.id}: unitTimes の数（${t.length}）が文単位の数（${units}）と違います`);
        if (t.length && t[0] !== 0) errors.push(`${ch.id}: unitTimes の先頭が 0 ではありません（${t[0]}）`);
        for (let i = 1; i < t.length; i++) {
          if (!(t[i] >= t[i - 1])) errors.push(`${ch.id}: unitTimes が単調非減少ではありません（${i} 番目 ${t[i - 1]} → ${t[i]}）`);
        }
      }
      return errors;
    },
  },
  {
    id: 'audio-duration',
    title: '章音声（本文・章題コール）が実在し、実尺が unitTimes と合う',
    // 許容誤差: unitTimes の各時刻は実尺 +0.5 秒以内。最終値と実尺の差は、
    // 区切り単位（---）で終わる章では 1.0 秒以内（末尾の区切り＝総尺の目印のため）、
    // それ以外の章では最終文の読みの長さとして 30 秒以内。
    run({ root }) {
      const book = readJson(root, 'data/chapters.json');
      const errors = [];
      for (const ch of book.chapters) {
        const bodyPath = join(root, 'public/book/audio', `${ch.id}.mp3`);
        const titlePath = join(root, 'public/book/audio', `${ch.id}-title.mp3`);
        if (!existsSync(bodyPath)) errors.push(`${ch.id}: 本文音声がありません: public/book/audio/${ch.id}.mp3`);
        if (!existsSync(titlePath)) errors.push(`${ch.id}: 章題コールがありません: public/book/audio/${ch.id}-title.mp3`);
        if (!existsSync(bodyPath) || !Array.isArray(ch.unitTimes) || ch.unitTimes.length === 0) continue;
        const dur = mediaDuration(bodyPath);
        if (dur === null) {
          errors.push(`${ch.id}: 本文音声の実尺を測れませんでした（ffprobe が必要です）`);
          continue;
        }
        const t = ch.unitTimes;
        const last = t[t.length - 1];
        if (last > dur + 0.5) errors.push(`${ch.id}: unitTimes の最終値（${last} 秒）が音声の実尺（${dur.toFixed(2)} 秒）を超えています`);
        const endsWithSep = (ch.paragraphs[ch.paragraphs.length - 1] ?? '').trim() === '---';
        const gap = dur - last;
        const limit = endsWithSep ? 1.0 : 30;
        if (gap > limit) {
          errors.push(
            `${ch.id}: 音声の実尺（${dur.toFixed(2)} 秒）と unitTimes の最終値（${last} 秒）の差が ${gap.toFixed(2)} 秒あります（許容 ${limit} 秒）`,
          );
        }
        if (existsSync(titlePath)) {
          const tdur = mediaDuration(titlePath);
          if (tdur === null) errors.push(`${ch.id}: 章題コールの実尺を測れませんでした（ffprobe が必要です）`);
          else if (tdur < 1) errors.push(`${ch.id}: 章題コールが短すぎます（${tdur.toFixed(2)} 秒）`);
        }
      }
      return errors;
    },
  },
  {
    id: 'audio-size',
    title: '音声の実容量が data.json の申告（audioBytes／totalAudioBytes）と合い、全章が precache 上限以下である',
    // 初回案内に出る総容量は data.json の totalAudioBytes が材料なので、実ファイルと
    // 食い違うと「表示と違う容量が落ちる」ことになる。あわせて、章ファイルが
    // vite.config.ts の precache 上限（maximumFileSizeToCacheInBytes）を超えると
    // その章だけ静かに precache から外れてオフラインで聞けなくなるため、ここで先に気づく。
    run({ root }) {
      const book = readJson(root, 'data/chapters.json');
      const errors = [];
      const cfg = readFileSync(join(root, 'vite.config.ts'), 'utf8');
      const capMatch = /maximumFileSizeToCacheInBytes:\s*(\d+)\s*\*\s*1024\s*\*\s*1024/.exec(cfg);
      const cap = capMatch ? Number(capMatch[1]) * 1024 * 1024 : null;
      if (cap === null) {
        errors.push('vite.config.ts の maximumFileSizeToCacheInBytes が「N * 1024 * 1024」の形で読めません（上限の検査ができません）');
      }
      let actualTotal = 0;
      for (const ch of book.chapters) {
        let sum = 0;
        for (const name of [`${ch.id}.mp3`, `${ch.id}-title.mp3`]) {
          const p = join(root, 'public/book/audio', name);
          if (!existsSync(p)) continue; // 実在そのものは audio-duration 検査の担当
          const size = statSync(p).size;
          sum += size;
          if (cap !== null && size > cap) {
            errors.push(`${ch.id}: ${name}（${(size / 1048576).toFixed(1)}MB）が precache 上限（${cap / 1048576}MB）を超えています。この章はオフライン再生できません（vite.config.ts の上限か、章の分け方を見直してください）`);
          }
        }
        actualTotal += sum;
        if (ch.audioBytes !== undefined && ch.audioBytes !== sum) {
          errors.push(`${ch.id}: audioBytes（${ch.audioBytes}）が実ファイルの合計（${sum}）と違います（work/build_data.py で作り直してください）`);
        }
        if (book.totalAudioBytes !== undefined && ch.audioBytes === undefined) {
          errors.push(`${ch.id}: totalAudioBytes があるのに audioBytes がありません（work/build_data.py で作り直してください）`);
        }
      }
      if (book.totalAudioBytes !== undefined && book.totalAudioBytes !== actualTotal) {
        errors.push(`totalAudioBytes（${book.totalAudioBytes}）が実ファイルの総計（${actualTotal}）と違います（初回案内の容量表示がずれます。work/build_data.py で作り直してください）`);
      }
      return errors;
    },
  },
  {
    id: 'ruby-source',
    title: 'ルビ記法を外すと正本の本文（paragraphs）と一致する',
    run({ root }) {
      const book = readJson(root, 'data/chapters.json');
      const errors = [];
      for (const ch of book.chapters) {
        if (!Array.isArray(ch.ruby) || ch.ruby.length !== ch.paragraphs.length) {
          errors.push(`${ch.id}: ruby の段落数（${ch.ruby?.length}）が paragraphs（${ch.paragraphs.length}）と違います`);
          continue;
        }
        ch.ruby.forEach((r, i) => {
          const stripped = r.replace(/《[^》]*》/g, '').replace(/｜/g, '');
          if (stripped !== ch.paragraphs[i]) {
            errors.push(`${ch.id}: ${i + 1} 段落目のルビを外した文が本文と違います（ルビの対象文が正本にありません）`);
          }
        });
      }
      return errors;
    },
  },
  {
    id: 'readings-ruby',
    title: 'ルビの読みが読み辞書（data/readings.json）と一致する',
    // 読み辞書には他作品でも使う共通項目も混ざっているため、「辞書の全項目が本文にあること」は
    // 求めない。ここで確かめるのは逆向き: 実際に本文へ付けられたルビのうち、辞書に載っている
    // 対象文については、読みが辞書と一致すること（辞書を直したのにルビが古い、等を止める）。
    run({ root }) {
      const book = readJson(root, 'data/chapters.json');
      const dict = readJson(root, 'data/readings.json');
      const errors = [];
      const pat = /｜(.+?)《([^》]*)》/g;
      for (const ch of book.chapters) {
        for (const r of ch.ruby ?? []) {
          for (const m of r.matchAll(pat)) {
            const [, base, reading] = m;
            if (Object.hasOwn(dict, base) && dict[base] !== reading) {
              errors.push(`${ch.id}: ルビ「${base}《${reading}》」が読み辞書（${dict[base]}）と違います`);
            }
          }
        }
      }
      return errors;
    },
  },
];
