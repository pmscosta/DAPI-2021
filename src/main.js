const WBK = require("wikibase-sdk");
const wdk = WBK({
    instance: "https://www.wikidata.org",
    sparqlEndpoint: "https://query.wikidata.org/sparql"
});

const DataFrame = require("dataframe-js").DataFrame;
const path = require("path");

const axios = require("axios").default;
const wikipedia = require("wtf_wikipedia");

const organizations = [];
const errors = [];
const parsedOrganizations = new Map(); // Stores code->name pairs for orgs

const updateRow = (df, criteria, setterParams) => df.map(
    (row) => (criteria(row)) ? row.set(...setterParams) : row
);

// params is an array of {org}
const parse_codes = async (orgs) => {

    const orgsToFetch = orgs.filter((org) => !parsedOrganizations.has(org.code));

    try {
        let docs = await wikipedia.fetch(orgsToFetch.map((org) => org.name), "en");
        if (!Array.isArray(docs)) { // Sometimes docs is only 1 value, so we need to wrap it
            docs = [docs];
        }
        docs.forEach((doc) => {
            try {
                parsedOrganizations.set(doc.wikidata(), doc.title());
                organizations.push([doc.title(), doc.section().text()]);
            } catch (e) {
                console.error("Could not fetch wikipedia info for doc", doc);
                console.error(e);
            }

        });
    } catch (e) {
        console.error("Could not fetch wikipedia info");
        console.error(e);
    }
};

const query = async (titles, initialDF) => {
    console.info("Querying: ", titles);
    let updatedDF = initialDF;
    try {
        const orgs = [];
        const gamesRestriction = titles.map((title) => `{?game rdfs:label "${title}"@en .}`).join(" UNION ");
        const publisher_query = `
            SELECT ?gameLabel ?publisher ?publisherLabel WHERE {
                hint:Query hint:optimizer "None" .
                
                ?game wdt:P31 wd:Q7889 .
                
                ${gamesRestriction}
                
                ?game wdt:P123 ?publisher .
                
                ?publisherProp wikibase:directClaim wdt:P123 . 

                SERVICE wikibase:label {bd:serviceParam wikibase:language "en" .}
                }
            `;
        const developer_query = `
                SELECT ?gameLabel ?developer ?developerLabel WHERE {
                    hint:Query hint:optimizer "None" .
                    
                    ?game wdt:P31 wd:Q7889 .

                    ${gamesRestriction}

                    ?game wdt:P178 ?developer .
                    
                    ?developerProp wikibase:directClaim wdt:P178 . 

                    SERVICE wikibase:label {bd:serviceParam wikibase:language "en" .}
                }
            `;

        const publisherCoveredTitles = new Set();
        const developerCoveredTitles = new Set();
        try {
            const publishers = (await axios.get(wdk.sparqlQuery(publisher_query))).data.results.bindings;
            publishers.forEach((row) => {
                if (row.publisherLabel) {
                    publisherCoveredTitles.add(row.gameLabel.value);
                    orgs.push({ code: row.publisher.value.slice(31), name: row.publisherLabel.value });
                    updatedDF = updateRow(
                        updatedDF,
                        (r) => r.get("name") === row.gameLabel.value,
                        ["publisher", row.publisherLabel.value]);
                }
            });
        } catch (e) {
            console.error("Could not query all publishers for titles", titles);
            console.error(e);
        }
        try {
            const developers = (await axios.get(wdk.sparqlQuery(developer_query))).data.results.bindings;
            developers.forEach((row) => {
                if (row.developerLabel) {
                    developerCoveredTitles.add(row.gameLabel.value);
                    orgs.push({ code: row.developer.value.slice(31), name: row.developerLabel.value });
                    updatedDF = updateRow(
                        updatedDF,
                        (r) => r.get("name") === row.gameLabel.value,
                        ["developer", row.developerLabel.value]);
                }
            });
        } catch (e) {
            console.error("Could not query all developers for titles", titles);
            console.error(e);
        }

        const uncoveredPublisherTitles = titles.filter((t) => !publisherCoveredTitles.has(t));
        const uncoveredDeveloperTitles = titles.filter((t) => !developerCoveredTitles.has(t));
        const publishersFromCSVForUncoveredTitlesSet =
        uncoveredPublisherTitles.reduce((publishers, title) => {
            publishers.add(updatedDF.find({ "name": title }).get("publisher"));
            return publishers;
        }, new Set());
        const developersFromCSVForUncoveredTitlesSet =
        uncoveredDeveloperTitles.reduce((developers, title) => {
            developers.add(updatedDF.find({ "name": title }).get("developer"));
            return developers;
        }, new Set());

        const missingOrgsSet = publishersFromCSVForUncoveredTitlesSet;
        developersFromCSVForUncoveredTitlesSet.forEach((d) => missingOrgsSet.add(d));
        if (missingOrgsSet.size > 0) {
            const missingOrgsRestriction = missingOrgsSet.map((org) => `{?org rdfs:label "${org}"@en .}`).join(" UNION ");

            console.log("RESTRICTION", missingOrgsRestriction);
            const missing_orgs_query = `
            SELECT ?org ?orgLabel WHERE {
                hint:Query hint:optimizer "None" .
            
                {?org wdt:P31 wd:Q210167 .}
                UNION
                {?org wdt:P31 wd:Q2085381 .}
                
                ${missingOrgsRestriction}
            
                SERVICE wikibase:label {bd:serviceParam wikibase:language "en" .}
            }
        `;

            const missingOrgs = (await axios.get(wdk.sparqlQuery(missing_orgs_query))).data.results.bindings;
            console.log("Querying missing orgs: ", missingOrgs.map((row) => row.orgLabel.value));
            orgs.push(...(missingOrgs).map((row) => row.orgLabel.value));

        }

        await parse_codes(orgs);
    } catch (e) {
        console.error("Something went wrong with chunk of ", titles);
        console.error(e);
        errors.push(...titles);
    }

    return updatedDF;

};

const chunkify = (arr, chunkSize) => {
    const chunks = [];
    for (let i = 0; i < arr.length; i += chunkSize)
        chunks.push(arr.slice(i, i + chunkSize));
    return chunks;
};

const enrich = async (names, initialDF) => {

    let updatedDF = initialDF;
    const chunks = chunkify(names, 10);
    for (const chunk of chunks) {
        updatedDF = await query(chunk, updatedDF);
    }

    return updatedDF;
}

// need to chunkify names and pass to query()
// await Promise.all(names.map((name) => {
//     console.log(name);
//     return query(name);
// }));

// // Create and save organizations csv
// organization_df = pd.DataFrame(new_entries, columns = ["organization", "description"]);
// organization_df.replace(to_replace=[r"\\t", r"\\n|\\r", "\t|\n|\r"], value=["\t","\n","\n"], regex=True, inplace=True)
// organization_df.to_csv('publisher-info.csv', index=False)
// // Update steam-store csv
// steamStoreDF.to_csv("updated-store.csv");
// // Write error
// errors_df = pd.DataFrame(errors, columns = ["title"]);
// errors_df.to_csv("errors.csv");
;

// enrich(steamStoreDF.iloc[0:6750,1])

const start = async () => {
    const steamStoreDF = await DataFrame.fromCSV(path.resolve(__dirname, "steam-store.csv")).then((df) => df);
    const names = steamStoreDF.select("name").toArray().map((el) => el[0]);

    const enrichedDF = await enrich(names.slice(0, 100), steamStoreDF);

    enrichedDF.toCSV(true, path.resolve(__dirname, "node-updated-store.csv"));

    const organizationsDF = new DataFrame(organizations, ["organization", "description"]);
    // organizationsDF.replace(to_replace=[r"\\t", r"\\n|\\r", "\t|\n|\r"], value=["\t","\n","\n"], regex=True, inplace=True)
    organizationsDF.toCSV(true, path.resolve(__dirname, "node-publisher-info.csv"));

};

start();
