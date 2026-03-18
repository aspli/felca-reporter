# FELCA Reporter

Extensão para Chrome e Edge que automatiza denúncias de vídeos com conteúdo inadequado para menores no YouTube, em conformidade com a **Lei nº 15.211/2025** (Estatuto Digital da Criança e do Adolescente), vigente desde 17 de março de 2026.

O nome é uma homenagem ao influenciador Felipe "Felca" Bressanim, cujo vídeo viral expôs a exploração de crianças em plataformas digitais e impulsionou a aprovação da lei.

---

## O que faz

Cole uma ou mais URLs de vídeos do YouTube, selecione o motivo, e a extensão abre cada vídeo em segundo plano e envia a denúncia usando sua sessão já autenticada — sem interação manual, sem configuração de API, sem envio de dados a terceiros.

Todo o histórico de denúncias fica salvo localmente no navegador, com data, hora e motivo de cada uma.

---

## Instalação

### Pré-requisitos
- Google Chrome 88+ ou Microsoft Edge 88+
- Conta Google com acesso ao YouTube

### Passo a passo

**1. Baixe a extensão**

Clique em "Code → Download ZIP" neste repositório e extraia a pasta `felca-reporter`.

**2. Ative o Modo Desenvolvedor**

- Chrome: abra `chrome://extensions/`
- Edge: abra `edge://extensions/`

Ative a chave **"Modo do desenvolvedor"** no canto superior direito.

**3. Carregue a extensão**

Clique em **"Carregar sem compactação"** (Chrome) ou **"Carregar sem pacote"** (Edge) e selecione a pasta `felca-reporter`.

O ícone 🛡️ aparecerá na barra de extensões. Se não aparecer, clique no ícone de quebra-cabeça 🧩 e fixe a extensão.

---

## Como usar

1. Faça login normalmente no YouTube no seu navegador
2. Clique no ícone 🛡️ da extensão
3. Cole as URLs dos vídeos que deseja denunciar (uma por linha):
   ```
   https://www.youtube.com/watch?v=XXXXXXXXXX
   https://youtu.be/YYYYYYYYYY
   ```
4. Selecione o motivo da denúncia:
   - **Conteúdo violento ou repulsivo** — jogos ou cenas com violência explícita
   - **Conteúdo sexual** — nudez ou conteúdo sexualmente sugestivo
   - **Abuso infantil ⭐ Lei Felca** — conteúdo que explora ou coloca crianças em risco
   - **Atos perigosos ou nocivos** — desafios perigosos, automutilação, etc.
5. Clique em **"Denunciar todos os vídeos"**

A extensão processa cada URL automaticamente e exibe o resultado em tempo real. O histórico completo fica disponível na aba **"Histórico"**.

---

## Fundamento legal

A Lei nº 15.211/2025 obriga as plataformas a:

- Implementar verificação de idade para conteúdos impróprios para menores
- Vincular contas de menores de 16 anos a um responsável legal
- Proibir publicidade direcionada a menores
- Impedir acesso de crianças a conteúdos nocivos

Criadores que publicam conteúdo com classificação +18 são obrigados a ativar a restrição de idade no YouTube Studio. O descumprimento sujeita as plataformas a multas de até **R$ 50 milhões**.

---

## Como funciona por dentro

A extensão replica o fluxo nativo de denúncia do YouTube:

1. Abre o vídeo em uma aba em segundo plano
2. Extrai a configuração InnerTube da página (`INNERTUBE_API_KEY`, versão do cliente)
3. Calcula o header de autenticação `SAPISIDHASH` usando SHA-1 e o cookie `SAPISID` da sua sessão
4. Chama os endpoints internos do YouTube na sequência:
   - `GET /youtubei/v1/get_panel` — obtém o formulário de denúncia com tokens
   - `POST /youtubei/v1/flow` — seleciona o motivo
   - `POST /youtubei/v1/feedback` — envia a denúncia

Tudo acontece no contexto da página do YouTube (same-origin), então os cookies de sessão são incluídos automaticamente. Nenhum dado passa por servidores externos.

---

## Privacidade

- Nenhum dado é coletado ou enviado a terceiros
- O histórico de denúncias fica armazenado apenas localmente no `chrome.storage.local`
- A extensão não acessa nenhuma informação além do necessário para enviar a denúncia

---

## Observações

- O YouTube pode aplicar limites por denúncias em sequência rápida. A extensão já inclui um intervalo de 1,2 segundos entre cada envio
- Os endpoints internos do YouTube podem mudar. Se a extensão parar de funcionar, abra uma issue neste repositório
- Esta ferramenta é para uso legítimo dentro da Lei Felca. Use com responsabilidade

---

## Contribuindo

Pull requests são bem-vindos. Para mudanças maiores, abra uma issue primeiro para discutir o que você gostaria de mudar.

---

*Feito com 💙 para proteger crianças e adolescentes no ambiente digital.*

---

## Mensagem adicional

A extensão inclui uma mensagem padrão enviada junto com cada denúncia:

> *Com a entrada em vigor da Lei nº 15.211/2025 (Lei Felca / ECA Digital) em 17 de março de 2026, as plataformas são obrigadas a garantir mecanismos de verificação de idade para conteúdos impróprios para menores. Este vídeo contém conteúdo inadequado sem a devida restrição de faixa etária, em descumprimento da legislação vigente.*

Você pode editar ou substituir essa mensagem diretamente na extensão antes de denunciar. O botão **"restaurar padrão"** recupera o texto original a qualquer momento. O limite é de 500 caracteres.

> **Nota técnica:** o campo de comentário é passado nos endpoints `flow` e `feedback` do InnerTube como `userComment`. Se você quiser confirmar que o texto está sendo recebido pelo YouTube, capture o request `flow?prettyPrint=false` no DevTools após uma denúncia manual com texto e compare o payload.
