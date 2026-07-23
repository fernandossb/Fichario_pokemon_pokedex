# Versão 0.28 — Motor de preços robusto

- Corrige o erro `ensureFxRates is not defined`.
- Usa uma cascata de preços: Cardmarket Trend, média de 30 dias, média de 7 dias, média de 24 horas, média histórica e menor oferta.
- Quando o Cardmarket não possui dados, tenta TCGplayer Market Price, preço médio e menor oferta.
- Mantém o último preço salvo quando uma consulta temporária falha.
- A atualização em lote faz até três tentativas por carta, com espera entre consultas, para reduzir falhas de conexão e bloqueios.
- A tela informa claramente quando uma carta realmente não possui dados públicos de mercado.
- A identificação continua validando coleção, número, ilustrador, acabamento, promoção e número da Pokédex quando disponível.
