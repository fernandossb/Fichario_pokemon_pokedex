FICHÁRIO POKÉMON — PATCH v0.21 IMAGENS EM CASCATA

ARQUIVOS ALTERADOS:
- app/src/main/assets/www/image-fallback.js
- app/build.gradle
- RELEASE_NOTES.md

COMO APLICAR:
1. Extraia este ZIP.
2. Copie as pastas/arquivos extraídos para a pasta principal do repositório.
3. Confirme "Substituir os arquivos no destino".
4. Abra o GitHub Desktop.
5. Confira que somente os 3 arquivos acima aparecem modificados.
6. Commit: Versão 0.21 - imagens em cascata
7. Push origin.
8. Aguarde o GitHub Actions ficar verde.
9. Abra o app; o atualizador interno deve oferecer a versão 0.21.

ORDEM DE BUSCA DE ARTE:
1. Foto salva pelo usuário.
2. Imagem registrada no catálogo.
3. Cache validado.
4. TCGdex pt-BR.
5. TCGdex pt.
6. TCGdex en.
7. Pokémon TCG API.
8. Mapa local de exceções.
9. Botão Recarregar arte.

OBSERVAÇÃO:
Nenhum sistema pode garantir 100% de cobertura se todas as fontes ainda não
possuírem determinada imagem. O patch amplia muito a cobertura e registra
diagnóstico local para casos restantes.
