const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');

dotenv.config();

const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
var admin = require("firebase-admin");

const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
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
        const servicesCollection = db.collection('services');
        const bookingsCollection = db.collection('bookings');
        const paymentsCollection = db.collection('payments');


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


        // bookings related apis
        app.get('/bookings', async (req, res) => {

            const email = req.query.email;
            const query = {};

            // if (email !== req.decoded_email) {
            //     return res.status(403).send({
            //         message: 'forbidden access'
            //     })
            // }

            if (email) {
                query = { userEmail: email }
            }

            const result = await bookingsCollection
                .find(query)
                .sort({ createdAt: -1 })
                .toArray();

            res.send(result);
        })

        // app.post('/bookings', async (req, res) => {
        //     const booking = req.body;

        //     // if (booking.userEmail !== req.decoded_email) {
        //     //     return res.status(403).send({
        //     //         message: 'forbidden access'
        //     //     })
        //     // }

        //     booking.createdAt = new Date();

        //     const result = await bookingsCollection.insertOne(booking);
        //     res.send(result);
        // })

        app.post('/bookings', async (req, res) => {
            const booking = req.body;
            booking.createdAt = new Date();
            booking.bookingStatus = 'pending';
            booking.paymentStatus = 'unpaid';
            const result = await bookingsCollection.insertOne(booking);
            res.send(result);
        });

        app.patch('/bookings/:id', async (req, res) => {
            const id = req.params.id;
            const status = req.body.status;

            const result = await bookingsCollection.updateOne(
                { _id: new ObjectId(id) },
                {
                    $set: {
                        bookingStatus: status
                    }
                }
            );

            res.send({ success: true, result });
        });

        // payments related apis
        app.get('/payments', async (req, res) => {
            const email = req.query.email;

            // if (email !== req.decoded_email) {
            //     return res.status(403).send({
            //         message: 'forbidden access'
            //     });
            // }

            const result = await paymentsCollection
                .find({ customerEmail: email })
                .sort({ paidAt: -1 })
                .toArray();

            res.send(result);
        });

        app.post('/create-checkout-session', async (req, res) => {
            try {
                const paymentInfo = req.body;
                const amount = parseInt(paymentInfo.amount * 100);
                const session = await stripe.checkout.sessions.create({
                    payment_method_types: ['card'],
                    line_items: [
                        {
                            price_data: {
                                currency: 'usd',
                                product_data: {
                                    name: paymentInfo.serviceName,
                                },
                                unit_amount: amount,
                            },
                            quantity: 1,
                        },
                    ],
                    mode: 'payment',
                    customer_email: paymentInfo.customerEmail,
                    metadata: {
                        bookingId: paymentInfo.bookingId,
                        serviceName: paymentInfo.serviceName,
                    },
                    success_url: `${process.env.CLIENT_URL}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
                    cancel_url: `${process.env.CLIENT_URL}/dashboard/my-bookings`,
                });
                res.send({ url: session.url });

            } catch (error) {
                console.log(error);
                res.status(500).send({
                    message: 'Stripe session failed'
                });
            }
        });

        app.patch('/payment-success', async (req, res) => {
            try {
                const sessionId = req.query.session_id;
                const session =
                    await stripe.checkout.sessions.retrieve(sessionId);
                const transactionId = session.payment_intent;
                // duplicate payment check
                const paymentExist = await paymentsCollection.findOne({
                    transactionId
                });

                if (paymentExist) {
                    return res.send({
                        success: true,
                        message: 'already paid',
                        payment: paymentExist
                    });
                }

                // success
                if (session.payment_status === 'paid') {
                    const bookingId = session.metadata.bookingId;
                    // booking update
                    const query = {
                        _id: new ObjectId(bookingId)
                    };
                    const updateDoc = {
                        $set: {
                            paymentStatus: 'paid',
                            bookingStatus: 'confirmed',
                        }
                    };
                    const updatedBooking =
                        await bookingsCollection.updateOne(
                            query,
                            updateDoc
                        );
                    // payment save
                    const paymentDoc = {
                        bookingId,
                        transactionId,
                        serviceName: session.metadata.serviceName,
                        amount: session.amount_total / 100,
                        currency: session.currency,
                        customerEmail: session.customer_email,
                        paymentStatus: session.payment_status,
                        paidAt: new Date(),
                    };

                    const paymentResult =
                        await paymentsCollection.insertOne(paymentDoc);

                    res.send({
                        success: true,
                        payment: {
                            _id: paymentResult.insertedId,
                            ...paymentData
                        }
                    });
                }

                res.send({
                    success: false
                });

            } catch (error) {
                console.log(error);
                res.status(500).send({
                    message: 'payment failed'
                });
            }
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