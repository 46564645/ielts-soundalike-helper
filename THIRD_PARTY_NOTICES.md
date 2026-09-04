# 第三方组件与服务说明

## Chrome TTS

- 精听词组发音优先使用 Chrome 扩展原生 `chrome.tts` 接口及电脑中已经安装的英语声音，不会为了发音发送 DeepSeek API Key 或精听原文。
- 浏览器不支持该接口时才回退到网页语音合成功能。

## DeepSeek API

- 接口：`https://api.deepseek.com/chat/completions`
- 模型：单词解释使用 `deepseek-v4-flash`；用户主动启动的精听口语素材分析使用 `deepseek-v4-pro`。两者均关闭思考模式并请求 JSON 输出。
- 用途：生成当前词的同义词场景区别与常用表达；或从用户当前打开的精听页中筛选适合雅思口语的词组、用法和例句。
- 单词解释只发送当前英文单词和本地中文释义。精听分析仅在用户点击“开始提取”后发送当前页提取到的正文/字幕，并可能因长度限制截取前 60,000 个字符。用户拼写、错误映射、API Key 和收藏不会随精听原文发送。
- API Key、开关、解释缓存、最近一次精听分析结果和精听词组收藏仅保存在浏览器本机扩展存储。
- DeepSeek 服务可用性、计费和内容使用条件以其官方条款为准。

## zhen-ke/phonetic-Symbols

扩展内的 KK 短音素 MP3 来自此公开 GitHub 仓库。接入时依据仓库 `index.html` 中的“音标—文件”对应关系，并按实际音值转换到本扩展使用的 IPA 记号。

- Source: https://github.com/zhen-ke/phonetic-Symbols
- Source commit: `9c0f20e39c72a1d6a13cf35f87dd5791faa7cd4a`
- Files used: the MP3 files referenced by the source repository's `index.html`
- License status: 截至上述提交，仓库根目录没有提供 `LICENSE` 或其他明确授权文件。使用者若要公开发布或商业分发本扩展，应先向原仓库作者确认音频授权。

## Datamuse API

用于精确查询单词的美式发音标记并转换为 IPA。它不用于生成或扩大相近词候选范围。

- https://www.datamuse.com/api/

## 在线单词音频

- 网站英式发音资源：`ai-oss3.oss-cn-shenzhen.aliyuncs.com/ielts_word/`
- 有道词典在线发音：`dict.youdao.com/dictvoice`

这些在线服务的可用性与使用条款由各自提供方决定。

## 雅思听力词汇数据

本地词库由用户提供的同桌英语自学网页词表导出文本整理而成，包括答案词、雅思听力核心词和 10 类雅思听力场景词。导入时按规范化单词去重，同时保留每个来源标签；其中一份完全重复的“场景 6”附件已忽略。

- 页面来源：`https://ielts.itongzhuo.com/business/ielts/student/jumpAnswerWordDictation.do`
- 本扩展内的去重词条：4148
- 原始成员关系：答案词 1746、核心词 1950、场景词 2176
- 这些词表仅随本地学习扩展使用；如需公开或商业分发，应自行确认网页内容及词库数据的授权范围。
