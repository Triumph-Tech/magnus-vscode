"use strict";

const path = require("path");

/**@type {import('webpack').Configuration}*/
const config = {
    target: "node",

    entry: "./src/extension.ts",

    output: {
        path: path.resolve(__dirname, "dist"),
        filename: "extension.js",
        libraryTarget: "commonjs2",
        devtoolModuleFilenameTemplate: "../[resource-path]"
    },

    devtool: "source-map",

    externals: {
        vscode: "commonjs vscode"
    },

    resolve: {
        extensions: [".ts", ".js"]
    },

    module: {
        rules: [
            {
                test: /\.ts$/,
                exclude: /node_modules/,
                use: [
                    {
                        loader: "ts-loader"
                    }
                ]
            },
            {
                test: /\.node$/,
                use: "node-loader"
            }
        ]
    },

    node: {
        __dirname: false
    }
};

module.exports = config;
