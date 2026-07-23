# Auditoria de cobertura do MYP Cards

Catálogo analisado: **13,845 cartas** em **123 coleções**.

## Limitação do teste

O MYP Cards não disponibiliza API pública nem uma exportação completa de preços. Um teste exato exigiria fazer 13,845 consultas individuais às páginas públicas ou ao mecanismo de busca, o que poderia sobrecarregar o site, provocar bloqueio anti-bot e produzir um resultado enganoso. Por isso, esta versão não declara uma quantidade inventada de cartas sem preço.

## O que foi validado

- O MYP possui páginas públicas de produto e de histórico com código de carta, coleção e Mediana MYP.
- Foram confirmadas correspondências para cartas recentes, promocionais e antigas, incluindo Meganium MEP 001 e Numel da Equipe Magma 001/34.
- A integração registra diagnóstico quando não encontra correspondência ou preço.

## Teste real dentro do aplicativo

A cobertura será acumulada conforme as cartas forem consultadas. O cache diferencia: encontrada com mediana, encontrada por menor oferta, não localizada e erro de conexão. Esse método mede o resultado real nos aparelhos sem disparar milhares de consultas simultâneas.
