import * as React from 'react';
import { inject, observer } from 'mobx-react';
import { RouteComponentProps, withRouter } from 'react-router';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import debounce from 'debounce';
import { schemas, schemaTypeMap, validators } from '@acryl/tx-json-schemas';
import { range } from '@utils/range';
import { AccountsStore, SettingsStore, SignerStore } from '@stores';
import { broadcast, signTx, libs } from '@acryl/acryl-transactions';

import MonacoEditor from 'react-monaco-editor';
import Dialog from '@src/components/Dialog';
import Button from '@src/components/Button';
import TransactionSigningForm from './TransactionSigningForm';
import styles from './styles.less';
import { DEFAULT_THEME_ID } from '@src/setupMonaco';
import { NotificationService } from '@services/notificationService';


interface IInjectedProps {
    signerStore?: SignerStore
    accountsStore?: AccountsStore
    settingsStore?: SettingsStore
    notificationService?: NotificationService
}

interface ITransactionEditorProps extends IInjectedProps, RouteComponentProps {
}

interface ITransactionEditorState {
    editorValue: string
    proofIndex: number
    seed: string
    selectedAccount: number
    signType: 'account' | 'seed'
    isAwaitingConfirmation: boolean
}

@inject('signerStore', 'settingsStore', 'accountsStore', 'notificationService')
@observer
class TransactionSigning extends React.Component<ITransactionEditorProps, ITransactionEditorState> {
    private editor?: monaco.editor.ICodeEditor;
    private model?: monaco.editor.IModel;

    private showMessage = (data: string) =>
        this.props.notificationService!.notify(data, {closable: true, duration: 10});

    state: ITransactionEditorState = {
        selectedAccount: this.props.accountsStore!.activeAccountIndex,
        editorValue: this.props.signerStore!.txJson,
        proofIndex: 0,
        seed: '',
        signType: 'account',
        isAwaitingConfirmation: false,
    };

    handleSign = async () => {
        if (!this.editor) return false;
        const accounts = this.props.accountsStore!.accounts;
        const {proofIndex, selectedAccount, signType, seed, editorValue} = this.state;
        const tx = libs.marshall.json.parseTx(editorValue);

        let signedTx: any;
        //ToDo: try to remove 'this.editor.updateOptions' after react-monaco-editor update
        signedTx = signTx(tx, {[proofIndex]: signType === 'seed' ? seed : accounts[selectedAccount].seed});

        let newEditorValue = JSON.stringify(signedTx, null, 2);
        // Find all unsafe longs and replace them in target json string
        const unsafeLongs = Object.values(signedTx)
            .filter((v) => typeof v === 'string' && parseInt(v) > Number.MAX_SAFE_INTEGER) as string[];
        unsafeLongs.forEach(unsafeLong => {
            newEditorValue = newEditorValue.replace(`"${unsafeLong}"`, unsafeLong);
        });

        const model = this.editor.getModel();
        if (model) {
            model.setValue(newEditorValue);
        }
        const {availableProofs} = this.parseInput(newEditorValue);
        this.setState({editorValue: newEditorValue, proofIndex: availableProofs[0]});
        return true;
    };


    handleSend = (txJson: string) => () => {
        const tx = libs.marshall.json.parseTx(txJson);
        const apiBase = this.props.settingsStore!.defaultNode!.url;

        broadcast(tx, apiBase)
            .then(tx => {
                this.onClose();
                this.showMessage(`Tx has been sent.\n ID: ${tx.id}`);
            })
            .catch(e => {
                this.showMessage(`Error occured.\n ERROR: ${JSON.stringify({...e, tx: undefined}, null, 4)}`);
            });
    };

    updateStoreValue = debounce((newVal: string) => this.props.signerStore!.setTxJson(newVal), 1000);

    handleEditorChange = (editorValue: string, e: monaco.editor.IModelContentChangedEvent) => {
        this.setState({editorValue});
        this.updateStoreValue(editorValue);
    };

    parseInput = (value: string) => {
        let result: { error?: string, availableProofs: number[] } = {
            availableProofs: []
        };
        try {
            const txObj = JSON.parse(value);
            const type = txObj.type;
            if (!type) {
                if (validators.TTx(txObj)) {
                    throw new Error(JSON.stringify(validators.TTx.errors));
                }

            }
            const paramsValidator = schemaTypeMap[type] && schemaTypeMap[type].paramsValidator;
            if (!paramsValidator) {
                throw new Error(`Invalid TX type ${type}`);
            }

            if (!paramsValidator(txObj)) {
                throw new Error(JSON.stringify(paramsValidator.errors));
            }

            txObj.proofs == null
                ? result.availableProofs = range(0, 8)
                : result.availableProofs = range(0, 8)
                    .filter((_, i) => !txObj.proofs[i]);
        } catch (e) {
            // Todo: library should implement custom error field with array of validation errors
            result.error = e.message;
            try {
                result.error = JSON.parse(e.message)
                    .map((msg: string | { message: string, dataPath: string }) => typeof msg === 'string'
                        ? msg
                        : `${msg.dataPath} ${msg.message}`.trim()).join(', ');
            } catch (e) {
            }
        }

        return result;
    };

    editorDidMount = (e: monaco.editor.ICodeEditor, m: typeof monaco) => {
        this.editor = e;
        const modelUri = m.Uri.parse('schemas://transaction.json');
        this.model = m.editor.createModel(this.state.editorValue, 'json', modelUri);
        m.languages.json.jsonDefaults.setDiagnosticsOptions({
            validate: true,
            schemas: [{
                uri: schemas.TTx.$id, // id of the first schema
                fileMatch: [modelUri.toString()], // associate with our model
                schema: schemas.TTx
            }]
        });
        m.editor.setTheme(DEFAULT_THEME_ID);
        e.setModel(this.model);
    };

    componentWillUnmount() {
        this.model && this.model.dispose();
    }

    onClose = () => this.props.history.push('/');

    render() {
        const accounts = this.props.accountsStore!.accounts;
        const {editorValue, seed, proofIndex, selectedAccount, isAwaitingConfirmation, signType} = this.state;
        const {availableProofs, error} = this.parseInput(editorValue);

        const signDisabled = !!error || (selectedAccount === -1 && !seed) || !availableProofs.includes(proofIndex)
            || (accounts.length === 0 && signType === 'account') || (seed === '' && signType === 'seed');


        let sendDisabled = true;
        try {
            sendDisabled = !validators.TTx(JSON.parse(editorValue));
        } catch (e) {
        }

        return (
            <Dialog
                width={960}
                height={800}
                title="Sign and publish"
                footer={<>
                    <Button className={styles.btn} onClick={this.onClose}>Cancel</Button>
                    <Button
                        className={styles.btn}
                        disabled={sendDisabled}
                        onClick={this.handleSend(editorValue)}
                        type="action-blue">
                        Publish
                    </Button>
                </>}
                onClose={this.onClose}
                visible={true}
                className={styles.root}

            >
                <div className={styles.codeEditor}>
                    <MonacoEditor
                        height={307}
                        width={864}
                        onChange={this.handleEditorChange}
                        editorDidMount={this.editorDidMount}
                        options={{
                            readOnly: isAwaitingConfirmation,
                            scrollBeyondLastLine: false,
                            minimap: {enabled: false},
                            selectOnLineNumbers: true,
                            renderLineHighlight: 'none',
                            contextmenu: false,
                        }}
                    />
                </div>
                {editorValue
                    ? <div className={styles.errorMsg}>{error}</div>
                    : <div className={styles.errorMsg}>Paste your transaction here 👆</div>
                }
                <div className={styles.signing}>

                    <TransactionSigningForm
                        isAwaitingConfirmation={isAwaitingConfirmation}
                        disableAwaitingConfirmation={() => this.setState({isAwaitingConfirmation: false})}
                        signDisabled={signDisabled}
                        signType={signType}
                        onSignTypeChange={v => this.setState({signType: v as any})}
                        accounts={accounts}
                        selectedAccount={selectedAccount}
                        seed={seed}
                        availableProofIndexes={availableProofs}
                        proofIndex={proofIndex}
                        onSign={this.handleSign}
                        onAccountChange={v => this.setState({selectedAccount: +v})}
                        onProofNChange={v => this.setState({proofIndex: +v})}
                        onSeedChange={v => this.setState({seed: v})}
                    />

                </div>


            </Dialog>
        );
    }
}


export default withRouter(TransactionSigning);



