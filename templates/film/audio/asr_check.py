"""旁白对稿：拿 ASR 回听的结果和原稿逐句比对，结果打印成 JSON，交付检查（build/qa.mjs）读它。

用法：python3 audio/asr_check.py
  原稿：audio/vo/index.json 里每句的 text（有 tts 字段时两者取差得少的那个）
  回听：audio/vo/asr.json，{"a1": "识别出的文字", ...} 或 {"a1": {"text": "..."}}，由 Agent 按
        references/服务与工具文档.md 的回听一节选 ASR 跑出来
比对规则：阿拉伯数字统一转成汉字读法、去掉标点后，按无调拼音逐字比。同音字不算错，只抓念错、漏念、多念。
依赖：pip install pypinyin cn2an
"""
import json
import os
import re
import sys

try:
    import cn2an
    from pypinyin import lazy_pinyin
except ImportError as e:
    print(json.dumps({"error": f"缺 Python 包 {e.name}，先 pip install pypinyin cn2an"}, ensure_ascii=False))
    sys.exit(0)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def norm(t):
    t = re.sub(r"(?<=\d),(?=\d)", "", t or "")
    try:
        t = cn2an.transform(t, "an2cn")
    except Exception:
        pass
    return re.sub(r"[^\w%]|_", "", t.lower())


def tokens(t):
    # 整句一起转拼音，多音字按词取音；汉字一个字一个音节，连续的字母数字算一个
    s = norm(t)
    py = lazy_pinyin(s, errors=lambda x: list(x))
    if len(py) != len(s):
        py = [lazy_pinyin(ch)[0] for ch in s]
    out = []
    for ch, p in zip(s, py):
        if re.match(r"[a-z0-9%]", ch) and out and re.match(r"[a-z0-9%]+$", out[-1][0]):
            out[-1] = (out[-1][0] + ch, out[-1][1] + ch)
        else:
            out.append((ch, p))
    return out


def diff(ref, hyp):
    # 编辑距离加回溯，返回错的个数和不一致的片段
    r, h = tokens(ref), tokens(hyp)
    n, m = len(r), len(h)
    d = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n + 1):
        d[i][0] = i
    for j in range(m + 1):
        d[0][j] = j
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            d[i][j] = min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1][1] != h[j - 1][1]))
    ops, i, j = [], n, m
    while i or j:
        if i and j and d[i][j] == d[i - 1][j - 1] + (r[i - 1][1] != h[j - 1][1]):
            ops.append(("=" if r[i - 1][1] == h[j - 1][1] else "~", r[i - 1][0], h[j - 1][0]))
            i, j = i - 1, j - 1
        elif i and d[i][j] == d[i - 1][j] + 1:
            ops.append(("-", r[i - 1][0], ""))
            i -= 1
        else:
            ops.append(("+", "", h[j - 1][0]))
            j -= 1
    ops.reverse()
    spans, cur = [], None
    for op, a, b in ops:
        if op == "=":
            if cur:
                spans.append(cur)
                cur = None
            continue
        cur = cur or {"ref": "", "hyp": ""}
        cur["ref"] += a
        cur["hyp"] += b
    if cur:
        spans.append(cur)
    return d[n][m], max(n, 1), spans


def main():
    idx = os.path.join(ROOT, "audio/vo/index.json")
    asr = os.path.join(ROOT, "audio/vo/asr.json")
    if not os.path.exists(asr):
        print(json.dumps({"error": "没有 audio/vo/asr.json"}, ensure_ascii=False))
        return
    VO = json.load(open(idx, encoding="utf-8"))
    A = json.load(open(asr, encoding="utf-8"))
    rows = {}
    for vid, v in VO.items():
        if vid not in A:
            continue
        hyp = A[vid]["text"] if isinstance(A[vid], dict) else A[vid]
        best = None
        for ref in [v.get("text", ""), v.get("tts")]:
            if not ref:
                continue
            e, n, spans = diff(ref, hyp)
            if best is None or e < best["errors"]:
                best = {"ref": ref, "hyp": hyp, "errors": e, "n": n, "spans": spans}
        best["rate"] = round(best["errors"] / best["n"], 4)
        rows[vid] = best
    print(json.dumps({"rows": rows}, ensure_ascii=False))


if __name__ == "__main__":
    main()
