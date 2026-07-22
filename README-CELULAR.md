# Fichário Pokémon — compilação pelo celular

Projeto Android autônomo para Android 8 ou superior, com `targetSdk 35` e Pokédex local.

## Conteúdo confirmado

- Aba Pokédex presente na navegação.
- 1.025 sprites locais.
- Dados da Pokédex incluídos no APK.
- Build automático no GitHub Actions.
- APK debug assinado automaticamente pelo Android Gradle Plugin.

## Depois de enviar ao GitHub

1. Abra o repositório.
2. Entre em **Actions**.
3. Abra **Gerar APK Android 16**.
4. Toque em **Run workflow**.
5. Quando terminar com marca verde, abra a execução.
6. Em **Artifacts**, baixe `Fichario-Pokemon-Pokedex-Android16`.
7. Extraia o ZIP do artefato e instale o APK.

O workflow também usa `apksigner verify` para interromper o processo se a assinatura estiver inválida.
