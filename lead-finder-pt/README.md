# Lead Finder PT

Aplicação Streamlit para investigar oficinas automóveis no Porto a partir do OpenStreetMap/Overpass, com SQLite local, verificação de formato/DNS do email, exportação CSV e controlos básicos de conformidade. Não envia emails.

## Executar

```bash
pip install -r requirements.txt
streamlit run app.py
```

## Deploy Streamlit Community Cloud

Para colocar esta aplicação online, escolha a pasta `lead-finder-pt` como caminho principal da aplicação se o serviço de deploy aceitar subpastas, ou mova estes ficheiros para um repositório dedicado. Defina `app.py` como entrypoint.

A base SQLite no hosting efémero pode ser perdida em reinícios; não guardar dados pessoais reais numa instância pública. Para persistência use um serviço de base de dados privado.

## Privacidade e fontes

A aplicação consulta OpenStreetMap via Overpass. Um website não registado nos dados OSM não prova que a empresa não possui website. Email e DNS não confirmam a caixa postal nem concedem autorização de marketing. Contacto comercial está fora do âmbito desta MVP. Rever as políticas da API e obrigações legais aplicáveis.
