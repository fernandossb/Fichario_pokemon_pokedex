# Assinatura definitiva do APK

Este projeto gera `assembleRelease` usando uma chave fixa guardada nos GitHub Actions Secrets.

Configure estes quatro segredos em:

`Settings → Secrets and variables → Actions → New repository secret`

- `ANDROID_KEYSTORE_BASE64`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

Os valores estão no pacote privado `Fichario-Pokemon-ASSINATURA-SEGURA.zip`.

Depois de configurar, qualquer `push` na branch `main` gera o artefato:

`Fichario-Pokemon-Assinado`

## Regra crítica

Nunca apague ou gere outra chave. Todas as atualizações futuras precisam usar a mesma chave. Guarde o pacote privado em pelo menos dois locais seguros e nunca o envie ao repositório público.
