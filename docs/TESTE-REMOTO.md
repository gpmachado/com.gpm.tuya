# Teste remoto: disponibilidade, queda de energia, hora, sirene e controle remoto

Roteiro de uns 30 a 40 minutos para quem testa em casa (Windows). O app grava um log com os detalhes e o
script `scripts/check-log.js` diz o que passou e o que falhou. Cada passo abaixo corresponde a uma
linha da saída do script. Faça só os passos dos aparelhos que você tem: os outros aparecem como `INFO`.

## 1. Preparar

Na pasta do app, no PowerShell:

```powershell
git pull
npm install
```

Abra `lib/constants.js` e troque `ZCL_DEBUG: false` por `ZCL_DEBUG: true` (**só para este teste**, não
faça commit disso). Depois:

```powershell
homey app run -r 2>&1 | Tee-Object -FilePath teste.log
```

- A **primeira linha do app** no log deve ser `My Tuya Devices v1.0.2 started (ZCL_DEBUG on)` (ou versão
  mais nova). Se não aparecer, o `git pull` não pegou a versão nova ou o `ZCL_DEBUG` não está ligado.
- **Espere 6 minutos antes de mexer em qualquer aparelho.** Nos 5 primeiros minutos o app ignora silêncio
  e falhas de envio de propósito (carência de boot): um teste feito antes disso não marca nada.
- Use um arquivo novo a cada rodada (`teste2.log`, `teste3.log`...). O `Tee-Object` sobrescreve o arquivo.

## 2. Aparelhos de tomada (módulo 1CH, régua, repetidor, sirene)

Escolha **um** aparelho de tomada, de preferência o módulo 1CH ou a régua, e faça na ordem:

1. **Queda de energia.** Tire o aparelho da tomada por uns 5 segundos e ligue de novo, **uma vez só**.
   Espere 1 minuto. Deve disparar **um** gatilho de rejoin (`device_rejoined`). O módulo costuma repetir o
   que enviou ao ligar uns 15 segundos depois: isso **não** pode gerar um segundo gatilho.
   *(linhas "power-cut trigger" e "repeated boot dumps")*
2. Espere uns 40 segundos. Então tire o aparelho da tomada e **deixe desligado**. No app do Homey, ligue e
   desligue esse aparelho **5 vezes**, uma a cada poucos segundos (cada toque tenta 3 vezes, então uns
   2 toques já bastam). No log: `Send failed (1/5)` até `(5/5)` e `Unavailable: No response to commands`.
   *(linha "5 failed sends")*
3. Ligue o aparelho de volta. Em até 10 segundos ele deve voltar a disponível, sozinho, no primeiro frame
   que chegar (`Restoring` e `Available`). *(linha "comes back")*
4. **Hora.** Ao ligar um aparelho de tomada, ele pergunta a hora ao Homey. A linha "time cluster" deve
   mostrar o fuso do seu Homey (por exemplo `UTC-3.0 h` no Brasil), e **não** `UTC+0.0 h`. Se o seu Homey
   está mesmo configurado em UTC, o `WARN` é normal. *(linha "time cluster")*

## 3. Sirene (Ekaza ou MOES)

1. Na tela do dispositivo, **troque a melodia** e, logo em seguida (1 ou 2 segundos), ligue a sirene.
   Faça 2 vezes, com melodias diferentes. Ela deve tocar de primeira. *(linha "siren starts")*
2. Troque a **duração** pela tela e ligue; depois digite outra duração nos Ajustes e ligue de novo.
   *(linha "siren durations used")*

Se aparecer `start not confirmed, retrying`, o app teve que repetir a partida (e deve ter tocado);
`Siren did not confirm the start` é uma falha: mande o log completo.

## 4. Controle remoto de 2 botões

Aperte cada botão: **1 vez** (single), **2 vezes rápido** (double) e **segure** (long). São 6 combinações.
*(linha "wireless remote buttons")*

## 5. Terminar e conferir

Pare o app com `Ctrl+C` e rode:

```powershell
node scripts/check-log.js teste.log
```

- Cole a saída do script na conversa. Ela não tem a chave da rede nem frames.
- **Não poste o `teste.log` em lugar público.** Com `ZCL_DEBUG` ligado o log tem endereços dos aparelhos.
  Mande o arquivo só para o Gabriel.
- Depois do teste, volte o `lib/constants.js` ao que estava (`git checkout lib/constants.js`).

### Como ler a saída

| Nível | Significa |
|---|---|
| PASS | passou |
| WARN | passo que falta fazer, ou algo a olhar (leia a frase) |
| FAIL | falhou: mande o log completo |
| INFO | só informação (versão, o que não foi exercitado) |

- `FAIL version`: o log é de uma versão antiga do app (sem a linha de versão).
- `WARN node address logged`: o log é de uma versão antiga (sem a linha `[Node] ieee=... nwk=...`).
- `INFO failed sends ... not exercised`: o passo 2 do item 2 não foi feito.
