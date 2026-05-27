const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
var admin = require("firebase-admin");

dotenv.config();

const { MongoClient, ServerApiVersion } = require('mongodb');
const uri = process.env.MONGO_URL;


var serviceAccount = require("./decor-nest-firebase-adminsdk.json");

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});


const app = express();
const port = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

const verifyFBToken = async (req, res, next) => {
    const token = req.headers.authorization;

    if (!token) {
        return res.status(401).send({ message: 'unauthorized access!' })
    }

    try {
        const idToken = token.split(' ')[1];
        const decoded = await admin.auth().verifyIdToken(idToken);
        req.decoded_email = decoded.email;
        next();
    }
    catch (error) {
        return res.status(401).send({ message: 'unauthorized access!' })
    }
}

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

async function run() {
    try {
        // Connect the client to the server	(optional starting in v4.7)
        await client.connect();
        const db = client.db('decor-nest');
        const usersCollection = db.collection('users');


        const verifyAdmin = async (req, res, next) => {
            const email = req.decoded_email;
            const query = { email };
            const user = await usersCollection.findOne(query);

            if (!user || user.role !== 'admin') {
                return res.status(403).send({ message: 'Forbidden access' });
            }
            next();
        }

        // users related apis
        app.post("/users", async (req, res) => {
            const user = req.body;

            const email = user.email;

            const existingUser = await usersCollection.findOne({ email, });

            // user already exists
            if (existingUser) {
                return res.send({
                    success: true,
                    message: "User already exists",
                    insertedId: null,
                });
            }

            // new user
            user.role = "user";
            user.createdAt = new Date();

            const result = await usersCollection.insertOne(user);

            res.send({
                success: true,
                message: "User created successfully",
                insertedId: result.insertedId,
            });
        });
        // Send a ping to confirm a successful connection
        await client.db("admin").command({ ping: 1 });
        console.log("Pinged your deployment. You successfully connected to MongoDB!");
    } finally {
        // Ensures that the client will close when you finish/error
        // await client.close();
    }
}
run().catch(console.dir);

app.get('/', (req, res) => {
    res.send('Welcome to Decor Nest!')
});

app.listen(port, () => {
    console.log(`Decor Nest listening on port ${port}`)
});