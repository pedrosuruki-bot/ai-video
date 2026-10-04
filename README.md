# AI Video Factory

Estúdio V1 para transformar um roteiro long-form em um pacote pronto para montagem no CapCut.

## Fluxo

```
SCRIPT
→ ANALYZE
→ STORYBOARD
→ VISUAIS IA / STOCK
→ TTS
→ SRT + VTT
→ TIMELINE
→ VALIDAÇÃO 100%
→ ZIP CAPCUT
```

O ZIP só é criado quando todas as cenas têm imagem e áudio válidos e quando storyboard, legendas, timeline e ficheiros auxiliares passam a validação. Assets vazios, HTML no lugar de imagem, áudio inválido, referências quebradas e pacotes parciais bloqueiam a exportação.

## Arranque local

```bash
npm install
cp .env.example .env.local
npm test
npm run dev
```

## Produção

`/api/diagnostics` verifica configuração, acesso aos modelos OpenAI e disponibilidade do Wikimedia Commons sem expor segredos.

Variáveis principais:

- `OPENAI_API_KEY`
- `OPENAI_MODEL`
- `OPENAI_IMAGE_MODEL`
- `OPENAI_TTS_MODEL`
- `OPENAI_TTS_VOICE`

Creatomate é opcional e só é usado pelo fluxo de renderização MP4. O pacote CapCut não depende dele.

## Exportação CapCut

O pacote usa:

```
VYNKO_TITULO_CAPCUT.zip
├── media/images/001.jpg...
├── media/audio/001.mp3...
├── captions.srt
├── captions.vtt
├── timeline.csv
├── storyboard.json
├── full-script.txt
├── GUIA-CAPCUT.txt
└── VALIDACAO-100.txt
```

Depois de gerar o ZIP, a aplicação abre novamente o ZIP no browser e valida a presença e os bytes dos assets antes de libertar o download. Porque aparentemente até os ficheiros zipados precisam de uma auditoria fiscal.
